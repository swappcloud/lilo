//! Optional native microphone capture via `cpal` (Tambourine-style).
//!
//! The primary voice path terminates WebRTC media in the webview. This module
//! is an alternative/complement for native capture: it streams RMS/peak level
//! events to the UI. It is gated behind the `native-audio` Cargo feature so the
//! default build has no audio-device dependency.
//!
//! Enable with: `cargo build --features native-audio`.

#[cfg(feature = "native-audio")]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use serde::Serialize;
    use tauri::{AppHandle, Emitter};

    #[derive(Clone, Serialize)]
    struct LevelEvent {
        rms: f32,
        peak: f32,
    }

    type StartResult = Result<(), String>;

    pub struct NativeCapture {
        stop: Mutex<Arc<AtomicBool>>,
        handle: Mutex<Option<JoinHandle<()>>>,
    }

    impl Default for NativeCapture {
        fn default() -> Self {
            Self::new()
        }
    }

    impl NativeCapture {
        pub fn new() -> Self {
            Self {
                stop: Mutex::new(Arc::new(AtomicBool::new(false))),
                handle: Mutex::new(None),
            }
        }

        pub fn start(&self, app: AppHandle) -> StartResult {
            self.stop();

            let host = cpal::default_host();
            let device = host
                .default_input_device()
                .ok_or_else(|| "no default input device".to_string())?;
            let supported = device
                .default_input_config()
                .map_err(|e| format!("no default input config: {e}"))?;
            let sample_format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();

            let stop = Arc::new(AtomicBool::new(false));
            let stop_thread = stop.clone();
            let (tx, rx) = std::sync::mpsc::channel::<StartResult>();

            let handle = std::thread::spawn(move || {
                let built = match sample_format {
                    cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, app),
                    cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, app),
                    cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, app),
                    other => Err(format!("unsupported sample format: {other:?}")),
                };

                match built {
                    Ok(stream) => {
                        if let Err(e) = stream.play() {
                            let _ = tx.send(Err(format!("failed to start stream: {e}")));
                            return;
                        }
                        let _ = tx.send(Ok(()));
                        while !stop_thread.load(Ordering::Relaxed) {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        let _ = stream.pause();
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                    }
                }
            });

            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(())) => {
                    if let Ok(mut guard) = self.stop.lock() {
                        *guard = stop;
                    }
                    *self.handle.lock().unwrap() = Some(handle);
                    Ok(())
                }
                Ok(Err(e)) => {
                    let _ = handle.join();
                    Err(e)
                }
                Err(e) => {
                    stop.store(true, Ordering::Relaxed);
                    let _ = handle.join();
                    Err(format!("timed out starting native audio: {e}"))
                }
            }
        }

        pub fn stop(&self) {
            if let Ok(guard) = self.stop.lock() {
                guard.store(true, Ordering::Relaxed);
            }
            if let Ok(mut guard) = self.handle.lock() {
                if let Some(handle) = guard.take() {
                    let _ = handle.join();
                }
            }
        }
    }

    impl Drop for NativeCapture {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        app: AppHandle,
    ) -> Result<cpal::Stream, String>
    where
        T: cpal::SizedSample,
        f32: cpal::FromSample<T>,
    {
        let err_fn = |e| eprintln!("native audio stream error: {e}");
        device
            .build_input_stream(
                config,
                move |data: &[T], _: &cpal::InputCallbackInfo| {
                    let mut peak = 0.0f32;
                    let mut sum = 0.0f32;
                    for &sample in data {
                        let value: f32 = sample.to_sample::<f32>();
                        let abs = value.abs();
                        if abs > peak {
                            peak = abs;
                        }
                        sum += value * value;
                    }
                    let rms = if data.is_empty() {
                        0.0
                    } else {
                        (sum / data.len() as f32).sqrt()
                    };
                    let _ = app.emit("native-audio-level", LevelEvent { rms, peak });
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("failed to build input stream: {e}"))
    }
}

#[cfg(not(feature = "native-audio"))]
mod imp {
    use tauri::AppHandle;

    /// Stub used when the `native-audio` feature is disabled.
    #[derive(Default)]
    pub struct NativeCapture;

    impl NativeCapture {
        pub fn new() -> Self {
            Self
        }

        pub fn start(&self, _app: AppHandle) -> Result<(), String> {
            Err(
                "native audio support was not compiled in (build with --features native-audio)"
                    .to_string(),
            )
        }

        pub fn stop(&self) {}
    }
}

pub use imp::NativeCapture;
