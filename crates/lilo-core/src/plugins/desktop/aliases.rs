//! Common spoken application names, independent of installation paths.

use super::normalize;

// Names identify products; aliases never declare that a product is installed.
const PROFILES: &[(&[&str], &[&str])] = &[
    (&["calculator", "gnomecalculator", "kcalc"], &["calculator"]),
    (&["vlc", "vlcmediaplayer"], &["vlc"]),
    (
        &["visualstudiocode", "codeoss"],
        &["vscode", "vs code", "code"],
    ),
    (&["cursor"], &["cursor"]),
    (&["sublimetext"], &["sublime", "sublime text"]),
    (&["notepad"], &["notepad"]),
    (&["notepadplusplus"], &["notepad plus plus"]),
    (&["googlechrome", "chrome"], &["chrome", "google chrome"]),
    (&["chromium", "chromiumwebbrowser"], &["chromium"]),
    (
        &["mozillafirefox", "firefox", "firefoxwebbrowser"],
        &["firefox"],
    ),
    (&["microsoftedge", "edge"], &["edge", "microsoft edge"]),
    (&["safari"], &["safari"]),
    (&["bravebrowser", "brave"], &["brave"]),
    (&["opera", "operabrowser"], &["opera"]),
    (&["slack"], &["slack"]),
    (&["discord"], &["discord"]),
    (
        &["microsoftteams", "teams", "microsoftteamsworkorschool"],
        &["teams", "microsoft teams"],
    ),
    (&["zoom", "zoomworkplace"], &["zoom"]),
    (&["telegram", "telegramdesktop"], &["telegram"]),
    (&["whatsapp", "whatsappdesktop"], &["whatsapp"]),
    (&["spotify"], &["spotify"]),
    (&["obsidian"], &["obsidian"]),
    (&["notion"], &["notion"]),
    (&["microsoftword", "word"], &["word", "microsoft word"]),
    (&["microsoftexcel", "excel"], &["excel", "microsoft excel"]),
    (
        &["microsoftpowerpoint", "powerpoint"],
        &["powerpoint", "power point"],
    ),
    (&["libreofficewriter"], &["writer", "libreoffice writer"]),
    (&["libreofficecalc"], &["calc", "libreoffice calc"]),
    (&["libreofficeimpress"], &["impress", "libreoffice impress"]),
    (
        &["terminal", "windowsterminal", "gnometerminal", "konsole"],
        &["terminal"],
    ),
    (&["iterm", "iterm2"], &["iterm", "iterm two"]),
    (
        &["powershell", "windowspowershell"],
        &["powershell", "power shell"],
    ),
    (&["commandprompt"], &["command prompt", "cmd"]),
    (
        &[
            "finder",
            "fileexplorer",
            "nautilus",
            "files",
            "dolphin",
            "thunar",
        ],
        &["files", "file manager"],
    ),
    (&["fileexplorer"], &["explorer", "file explorer"]),
];

pub(super) fn for_name(name: &str) -> Vec<String> {
    let name = normalize(&name.replace("++", " plus plus"));
    PROFILES
        .iter()
        .filter(|(names, _)| names.contains(&name.as_str()))
        .flat_map(|(_, aliases)| aliases.iter().map(|alias| (*alias).to_owned()))
        .collect()
}

pub(super) fn words() -> Vec<String> {
    let mut words: Vec<_> = PROFILES
        .iter()
        .flat_map(|(_, aliases)| aliases.iter())
        .flat_map(|alias| alias.split_whitespace().map(str::to_owned))
        .collect();
    words.sort_unstable();
    words.dedup();
    words
}
