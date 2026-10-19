// Example LILO plugin: looks at the user's screen.
//
// A spoken request produces a screenshot; the frame goes back as base64 in the
// tool result, and the host uploads it and shows it to the live session's
// model. The plugin never sees an account or a token.
//
// On Windows the host captures in-process (`lilo.screenshot`, granted by the
// `screen:capture` capability): the old PowerShell capture script is blocked
// by antivirus engines as spyware. It stays only as a fallback for hosts
// without `lilo.screenshot`. Elsewhere the machine is reached only through the
// binaries the manifest declares: macOS `screencapture` + `sips`, Linux
// grim/gnome-screenshot/spectacle/import. `lilo.temp` hands a tool a path under the plugin's
// scratch folder and `lilo.readBase64` reads those bytes back — both confined
// to that folder — while `lilo.platform` picks the tool, so one file covers
// every OS.
//
// macOS asks for Screen Recording the first time `screencapture` runs; the
// "Allow screen recording" action on this plugin's page exists to trigger that
// dialog, because a denied capture can come back as a picture of the wallpaper
// only.

const MAX_EDGE = 1600;
const FALLBACK_TEXT =
  "The attached image is the user's screen. Use it to answer what they just asked.";
const MAC_HINT =
  "could not capture the screen — allow it under System Settings → Privacy & Security → Screen Recording, then try again (a restart may be needed). Running from source, macOS attributes captures to the raw dev binary: add target/debug/lilo there with \"+\", or test the packaged app";

function tryRun(program, args) {
  try {
    return lilo.exec(program, args);
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: String(error && error.message ? error.message : error),
    };
  }
}

// PowerShell grabs the primary screen, scales it and saves a JPEG. Only for a
// host without `lilo.screenshot`.
function windowsScript(path) {
  const quoted = path.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
    "$s=[Math]::Min(1.0," + MAX_EDGE + "/[Math]::Max($b.Width,$b.Height));",
    "$w=[int][Math]::Max(1,[Math]::Round($b.Width*$s));",
    "$h=[int][Math]::Max(1,[Math]::Round($b.Height*$s));",
    "$f=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
    "$g=[System.Drawing.Graphics]::FromImage($f);",
    "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
    "$o=New-Object System.Drawing.Bitmap $w,$h;",
    "$d=[System.Drawing.Graphics]::FromImage($o);",
    "$d.DrawImage($f,0,0,$w,$h);",
    "$o.Save('" + quoted + "',[System.Drawing.Imaging.ImageFormat]::Jpeg);",
    "$d.Dispose(); $o.Dispose(); $g.Dispose(); $f.Dispose()",
  ].join(" ");
}

// A frame — base64 `data` from the host, or a file in the scratch folder —
// plus its mime type. The file names are
// fixed, so repeated captures overwrite instead of piling up.
function capture() {
  if (lilo.platform === "macos") {
    const path = lilo.temp("shot.jpg");
    const result = tryRun("screencapture", ["-x", "-t", "jpg", path]);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(detail ? MAC_HINT + " (" + detail + ")" : MAC_HINT);
    }
    // A frame the model can read is ~1600 px on the long edge; the full
    // Retina file would not fit the protocol's line budget.
    tryRun("sips", ["-Z", String(MAX_EDGE), path]);
    return { path: path, mime: "image/jpeg" };
  }
  if (lilo.platform === "windows") {
    if (typeof lilo.screenshot === "function") {
      return { data: lilo.screenshot(MAX_EDGE), mime: "image/jpeg" };
    }
    const path = lilo.temp("shot.jpg");
    const script = windowsScript(path);
    if (tryRun("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]).code !== 0) {
      throw new Error("could not capture the screen with PowerShell");
    }
    return { path: path, mime: "image/jpeg" };
  }
  const jpeg = lilo.temp("shot.jpg");
  if (tryRun("grim", ["-t", "jpeg", jpeg]).code === 0) {
    return { path: jpeg, mime: "image/jpeg" };
  }
  const png = lilo.temp("shot.png");
  const tools = [
    ["gnome-screenshot", ["-f", png]],
    ["spectacle", ["-b", "-n", "-o", png]],
    ["import", ["-window", "root", png]],
  ];
  for (let i = 0; i < tools.length; i += 1) {
    if (tryRun(tools[i][0], tools[i][1]).code === 0) {
      return { path: png, mime: "image/png" };
    }
  }
  throw new Error(
    "no screenshot tool is installed — install grim, gnome-screenshot, spectacle or ImageMagick",
  );
}

function readShot(shot) {
  if (shot.data) {
    return shot.data;
  }
  try {
    return lilo.readBase64(shot.path);
  } catch (error) {
    const detail = error && error.message ? error.message : error;
    throw new Error(lilo.platform === "macos" ? MAC_HINT : "could not read the screenshot: " + detail);
  }
}

function describe() {
  return {
    tools: [
      {
        name: "screen_look",
        description:
          "Take a screenshot of the user's screen and look at it. Use when the user asks for help with what is on their screen, asks what you can see, or asks you to look at their screen.",
        parameters: {
          type: "object",
          properties: {
            asking: {
              type: "string",
              description: "What the user wants to know about the screen, in their own words.",
            },
          },
          required: [],
        },
      },
      {
        name: "screen_permission",
        description:
          "Ask the operating system for screen-recording permission by attempting one capture. Use when the user asks why LILO cannot see the screen, or wants to grant it.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
    commands: [
      {
        name: "screen.look",
        scope: "tool",
        tool: "screen_look",
        descriptions: [
          ["en", "Look at the user's screen."],
          ["pt", "Olha a tela do usuário."],
          ["it", "Guarda lo schermo dell'utente."],
        ],
        requiresConfirm: false,
        templates: [
          ["en", "(look at|see|check) [my] screen"],
          ["en", "what (do|can) you see [on] [my] [screen]"],
          ["en", "tell me what you [can] see"],
          ["en", "what (is|s) on [my] screen"],
          ["en", "(take|grab) a screenshot"],
          ["en", "help me (fix|solve) (this|that|it)"],
          ["en", "(look|see) at what i (am|m) doing"],
          ["pt", "(olha|olhar|ver|vê) [a|minha] tela"],
          ["pt", "o que você (vê|ve|consegue ver|pode ver|está vendo|tá vendo) [na] [minha] [tela]"],
          ["pt", "me (diz|diga|fala|fale) o que você (vê|ve|está vendo|tá vendo)"],
          ["pt", "o que (tem|há|aparece) na [minha] tela"],
          ["pt", "(dá|da|dê) uma olhada [na] [minha] tela"],
          ["pt", "(tira|tire|tirar|capture|captura) [um|uma] (print|screenshot|captura de tela)"],
          ["pt", "o que [é] [que] [tem] [na|on] (minha|my) (tela|screen)"],
          ["pt", "me (ajuda|ajude) a (resolver|consertar) (isso|isto|esse|este) [problema]"],
          ["pt", "(olha|olhar|vê|ver) o que eu (estou|tô) fazendo"],
          ["it", "(guarda|vedi|controlla) [il|lo] schermo"],
          ["it", "cosa (vedi|c è) [sullo schermo]"],
          ["it", "aiutami a (risolvere|sistemare) [questo]"],
        ],
      },
    ],
    ui: {
      actions: [{ label: "Allow screen recording", tool: "screen_permission" }],
    },
    prompt:
      "Sees the user's screen on request: when they ask for help with something they are looking at, take a screenshot and explain what to do. The Screen page in Settings has an action that asks macOS for the screen-recording permission.",
  };
}

function invoke(tool, args) {
  if (tool === "screen_look") {
    const shot = capture();
    const data = readShot(shot);
    const asking = args && typeof args.asking === "string" ? args.asking.trim() : "";
    return {
      summary: "looked at your screen",
      screen: {
        data: data,
        mime: shot.mime,
        text: asking
          ? "The attached image is the user's screen. The user asks: " + asking
          : FALLBACK_TEXT,
      },
    };
  }
  if (tool === "screen_permission") {
    // One capture is the request: macOS shows its dialog the first time.
    readShot(capture());
    return { summary: "screen recording is allowed" };
  }
  throw new Error("unknown tool " + tool);
}
