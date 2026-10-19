//! PocketSphinx 0.8 ABI and PulseAudio PCM capture, confined to a worker thread.
//! Distribution packages provide the BSD-licensed recognizer and English model.

use super::{Event, Options};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc::SyncSender, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[link(name = "dl")]
extern "C" {
    fn dlopen(file: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
}

struct Library(*mut c_void);
impl Library {
    fn open(path: &Path) -> Result<Self, String> {
        use std::os::unix::ffi::OsStrExt;
        let path =
            CString::new(path.as_os_str().as_bytes()).map_err(|_| "Invalid library path.")?;
        // RTLD_NOW | RTLD_GLOBAL resolves the separately loaded SphinxBase ABI.
        let handle = unsafe { dlopen(path.as_ptr(), 2 | 0x100) };
        if handle.is_null() {
            return Err("Linux wake libraries are unavailable.".into());
        }
        Ok(Self(handle))
    }
    unsafe fn symbol<T: Copy>(&self, name: &'static [u8]) -> Result<T, String> {
        let pointer = dlsym(self.0, name.as_ptr().cast());
        if pointer.is_null() || std::mem::size_of::<T>() != std::mem::size_of::<*mut c_void>() {
            return Err("Linux wake library ABI is unsupported.".into());
        }
        // Call sites select the documented function-pointer type for each symbol.
        Ok(std::mem::transmute_copy(&pointer))
    }
}
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            dlclose(self.0);
        }
    }
}

type Args = unsafe extern "C" fn() -> *const c_void;
type Parse =
    unsafe extern "C" fn(*mut c_void, *const c_void, i32, *mut *mut c_char, i32) -> *mut c_void;
type ConfigFree = unsafe extern "C" fn(*mut c_void) -> i32;
type Init = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type Free = unsafe extern "C" fn(*mut c_void) -> i32;
type Utterance = unsafe extern "C" fn(*mut c_void) -> i32;
type Process = unsafe extern "C" fn(*mut c_void, *const i16, usize, i32, i32) -> i32;
type Hypothesis = unsafe extern "C" fn(*mut c_void, *mut i32) -> *const c_char;

struct Decoder {
    keyword: String,
    pointer: *mut c_void,
    config: *mut c_void,
    free: Free,
    config_free: ConfigFree,
    begin: Utterance,
    end: Utterance,
    process: Process,
    hypothesis: Hypothesis,
    dictionary: PathBuf,
    _pocket: Library,
    _base: Library,
}

fn dictionary(phrase: &str, source: &Path) -> Result<String, String> {
    let words: BTreeSet<_> = phrase.split_whitespace().collect();
    let mut found = BTreeMap::<String, Vec<String>>::new();
    let reader =
        BufReader::new(File::open(source).map_err(|_| "Linux wake dictionary is unavailable.")?);
    for line in reader.lines() {
        let line = line.map_err(|_| "Linux wake dictionary could not be read.")?;
        let Some((word, phones)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let base = word.split('(').next().unwrap_or(word);
        if words.contains(base) && base != "lilo" {
            found
                .entry(base.into())
                .or_default()
                .push(format!("{word} {}", phones.trim()));
        }
    }
    if words.contains("lilo") {
        found.insert(
            "lilo".into(),
            vec!["lilo L IY L OW".into(), "lilo(2) L AY L OW".into()],
        );
    }
    for (word, phones) in [("oi", "OY"), ("ei", "EY"), ("ciao", "CH AW")] {
        if words.contains(word) && !found.contains_key(word) {
            found.insert(word.into(), vec![format!("{word} {phones}")]);
        }
    }
    if words.iter().any(|word| !found.contains_key(*word)) {
        return Err(
            "The wake phrase contains a word absent from the Linux model dictionary.".into(),
        );
    }
    Ok(found.into_values().flatten().collect::<Vec<_>>().join("\n") + "\n")
}

impl Decoder {
    fn new(options: &Options) -> Result<Self, String> {
        let library = |name: &str| {
            options
                .library_dir
                .as_ref()
                .map_or_else(|| PathBuf::from(name), |root| root.join(name))
        };
        let base = Library::open(&library("libsphinxbase.so.3"))?;
        let pocket = Library::open(&library("libpocketsphinx.so.3"))?;
        let args: Args = unsafe { pocket.symbol(b"ps_args\0")? };
        let parse: Parse = unsafe { base.symbol(b"cmd_ln_parse_r\0")? };
        let config_free: ConfigFree = unsafe { base.symbol(b"cmd_ln_free_r\0")? };
        let init: Init = unsafe { pocket.symbol(b"ps_init\0")? };
        let free: Free = unsafe { pocket.symbol(b"ps_free\0")? };
        let begin: Utterance = unsafe { pocket.symbol(b"ps_start_utt\0")? };
        let end: Utterance = unsafe { pocket.symbol(b"ps_end_utt\0")? };
        let process: Process = unsafe { pocket.symbol(b"ps_process_raw\0")? };
        let hypothesis: Hypothesis = unsafe { pocket.symbol(b"ps_get_hyp\0")? };
        let contents = dictionary(
            &options.phrase,
            &options.model_dir.join("cmudict-en-us.dict"),
        )?;
        fs::create_dir_all(&options.state_dir).map_err(|_| "Linux wake state is unavailable.")?;
        fs::set_permissions(&options.state_dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Linux wake state permissions failed.")?;
        let dictionary = options
            .state_dir
            .join(format!("{}.dict", uuid::Uuid::new_v4()));
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&dictionary)
            .map_err(|_| "Linux wake dictionary could not be prepared.")?;
        use std::io::Write;
        file.write_all(contents.as_bytes())
            .map_err(|_| "Linux wake dictionary could not be prepared.")?;
        drop(file);
        let values = [
            "lilo-wake".into(),
            "-hmm".into(),
            options
                .model_dir
                .join("en-us")
                .to_string_lossy()
                .into_owned(),
            "-dict".into(),
            dictionary.to_string_lossy().into_owned(),
            "-keyphrase".into(),
            options.phrase.clone(),
            "-samprate".into(),
            "16000".into(),
            "-kws_threshold".into(),
            "1e-10".into(),
            "-logfn".into(),
            "/dev/null".into(),
        ];
        let strings = values
            .iter()
            .map(|value| CString::new(value.as_str()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Invalid Linux wake configuration.")?;
        let mut argv: Vec<*mut c_char> = strings
            .iter()
            .map(|value| value.as_ptr().cast_mut())
            .collect();
        // All argument pointers remain alive throughout parsing; the library copies values.
        let config = unsafe {
            parse(
                std::ptr::null_mut(),
                args(),
                argv.len() as i32,
                argv.as_mut_ptr(),
                1,
            )
        };
        if config.is_null() {
            let _ = fs::remove_file(&dictionary);
            return Err("Linux wake configuration failed.".into());
        }
        let pointer = unsafe { init(config) };
        if pointer.is_null() {
            unsafe {
                config_free(config);
            }
            let _ = fs::remove_file(&dictionary);
            return Err("Linux wake model could not be initialized.".into());
        }
        let decoder = Self {
            keyword: options.phrase.clone(),
            pointer,
            config,
            free,
            config_free,
            begin,
            end,
            process,
            hypothesis,
            dictionary,
            _pocket: pocket,
            _base: base,
        };
        if unsafe { begin(pointer) } < 0 {
            return Err("Linux wake listener could not start.".into());
        }
        Ok(decoder)
    }
    fn feed(&mut self, samples: &[i16]) -> Result<bool, String> {
        // The decoder lives on one worker; PCM is mono signed 16-bit at 16 kHz.
        if unsafe { (self.process)(self.pointer, samples.as_ptr(), samples.len(), 0, 0) } < 0 {
            return Err("Linux wake decoding failed.".into());
        }
        let text = unsafe { (self.hypothesis)(self.pointer, std::ptr::null_mut()) };
        if text.is_null() || unsafe { CStr::from_ptr(text) }.to_bytes() != self.keyword.as_bytes() {
            return Ok(false);
        }
        if unsafe { (self.end)(self.pointer) } < 0 || unsafe { (self.begin)(self.pointer) } < 0 {
            return Err("Linux wake listener could not rearm.".into());
        }
        Ok(true)
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            (self.end)(self.pointer);
            (self.free)(self.pointer);
            (self.config_free)(self.config);
        }
        let _ = fs::remove_file(&self.dictionary);
    }
}

pub struct WakeListener {
    stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    capture: Arc<Mutex<Option<Child>>>,
    worker: Option<JoinHandle<()>>,
}
impl WakeListener {
    pub fn start(options: Options, events: SyncSender<Event>) -> Result<Self, String> {
        options.validate()?;
        let stop = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicBool::new(false));
        let capture = Arc::new(Mutex::new(None));
        let (worker_stop, worker_running, worker_capture) =
            (stop.clone(), running.clone(), capture.clone());
        let worker = std::thread::spawn(move || {
            let result = listen(
                options,
                &events,
                &worker_stop,
                &worker_running,
                &worker_capture,
            );
            worker_running.store(false, Ordering::Release);
            if !worker_stop.load(Ordering::Acquire) && result.is_err() {
                let _ = events.try_send(Event::Blocked { reason: "recognizer-error", detail: "Linux wake listening failed. Check the model, audio service and microphone." });
            }
            if let Some(mut child) = worker_capture
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take()
            {
                let _ = child.kill();
                let _ = child.wait();
            }
        });
        Ok(Self {
            stop,
            running,
            capture,
            worker: Some(worker),
        })
    }
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(child) = self
            .capture
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_mut()
        {
            let _ = child.kill();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for WakeListener {
    fn drop(&mut self) {
        self.stop();
    }
}

fn listen(
    options: Options,
    events: &SyncSender<Event>,
    stop: &AtomicBool,
    running: &AtomicBool,
    capture: &Mutex<Option<Child>>,
) -> Result<(), String> {
    let mut decoder = Decoder::new(&options)?;
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    let mut child = Command::new(&options.capture_binary)
        .args([
            "--raw",
            "--rate=16000",
            "--channels=1",
            "--format=s16le",
            "--latency-msec=100",
            "--client-name=LILO Wake",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Linux microphone capture is unavailable.")?;
    let mut audio = child
        .stdout
        .take()
        .ok_or("Linux microphone capture has no stream.")?;
    {
        let mut guard = capture.lock().unwrap_or_else(|poison| poison.into_inner());
        if stop.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        *guard = Some(child);
    }
    let mut bytes = [0u8; 3200];
    let mut samples = [0i16; 1600];
    let mut ready = false;
    let mut last_detection: Option<Instant> = None;
    while !stop.load(Ordering::Acquire) {
        audio
            .read_exact(&mut bytes)
            .map_err(|_| "Linux microphone stream stopped.")?;
        if stop.load(Ordering::Acquire) {
            break;
        }
        if !ready {
            ready = true;
            running.store(true, Ordering::Release);
            let _ = events.try_send(Event::Ready);
        }
        for (sample, pair) in samples.iter_mut().zip(bytes.chunks_exact(2)) {
            *sample = i16::from_le_bytes([pair[0], pair[1]]);
        }
        if decoder.feed(&samples)?
            && last_detection.map_or(true, |last| last.elapsed() >= Duration::from_secs(2))
        {
            last_detection = Some(Instant::now());
            let _ = events.try_send(Event::Detected);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyword_dictionary_is_scoped_and_unknown_words_fail() {
        let root =
            std::env::temp_dir().join(format!("lilo-wake-dictionary-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("dictionary");
        fs::write(
            &source,
            "hello HH AH L OW\nhello(2) HH EH L OW\nother AH DH ER\n",
        )
        .unwrap();
        let result = dictionary("hello lilo", &source).unwrap();
        assert!(result.contains("hello(2)"));
        assert!(result.contains("lilo L IY L OW"));
        assert!(!result.contains("other"));
        assert!(dictionary("unknown lilo", &source).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_resources_report_failure_without_panicking() {
        let mut options = Options::new("lilo", PathBuf::from("fixture"));
        options.library_dir = Some(PathBuf::from("missing-wake-libraries"));
        let (send, receive) = std::sync::mpsc::sync_channel(8);
        let mut listener = WakeListener::start(options, send).unwrap();
        assert!(matches!(
            receive.recv_timeout(Duration::from_secs(5)).unwrap(),
            Event::Blocked { .. }
        ));
        listener.stop();
        assert!(!listener.is_running());
    }
    #[test]
    #[ignore = "requires the distribution model and an upstream recorded PCM fixture"]
    fn recorded_keyword_acceptance() {
        let input = std::env::var_os("LILO_WAKE_TEST_AUDIO")
            .expect("LILO_WAKE_TEST_AUDIO points to goforward.raw");
        let bytes = fs::read(input).unwrap();
        assert_eq!(bytes.len() % 2, 0);
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.tmp")
            .join(format!("wake-acceptance-{}", uuid::Uuid::new_v4()));
        let options = Options::new("go forward", root.clone());
        let mut decoder = Decoder::new(&options).expect("Distribution wake model must initialize");
        let started = Instant::now();
        let mut detections = 0;
        for chunk in samples.chunks(1600) {
            detections += usize::from(decoder.feed(chunk).unwrap());
        }
        for _ in 0..10 {
            detections += usize::from(decoder.feed(&[0; 1600]).unwrap());
        }
        assert_eq!(detections, 1, "The recorded keyword must be detected once");
        println!(
            "Recorded PCM duration: {:.2}s; decode duration: {:.3}s",
            samples.len() as f64 / 16000.0,
            started.elapsed().as_secs_f64()
        );
        if let Ok(status) = fs::read_to_string("/proc/self/status") {
            for line in status
                .lines()
                .filter(|line| line.starts_with("VmRSS:") || line.starts_with("VmHWM:"))
            {
                println!("Native acceptance process {line}");
            }
        }
        drop(decoder);
        let mut negative = Decoder::new(&Options::new("lilo", root.clone())).unwrap();
        for chunk in samples.chunks(1600) {
            assert!(
                !negative.feed(chunk).unwrap(),
                "Unrelated recorded speech must not activate LILO"
            );
        }
        for _ in 0..100 {
            assert!(
                !negative.feed(&[0; 1600]).unwrap(),
                "Silence must not activate LILO"
            );
        }
        drop(negative);
        fs::remove_dir_all(root).unwrap();
    }
}
