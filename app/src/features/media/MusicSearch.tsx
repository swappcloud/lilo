import { useRef, useState } from "react";
import { runTool } from "../../lib/gateway";
import { useTranslation } from "../../i18n";
import { useMediaStore } from "../../store/mediaStore";
import { Button, Section } from "../../shared/ui/primitives";
import { PlayIcon } from "../../shared/ui/icons";

interface SearchTrack {
  id: string;
  title: string;
  artist: string;
  artworkUrl?: string | null;
}

/** Explicit searches keep network work bounded and selection uses the exact result. */
export function MusicSearch() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<SearchTrack[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const search = async () => {
    if (!query.trim() || searching || playing) return;
    const revision = ++generation.current;
    setSearching(true);
    setError(null);
    try {
      const result = await runTool("media_search", { query: query.trim(), limit: 8 }) as { tracks: SearchTrack[] };
      if (revision !== generation.current) return;
      setTracks(result.tracks);
      setSearched(true);
    } catch {
      if (revision === generation.current) setError(t("music.searchError"));
    } finally {
      if (revision === generation.current) setSearching(false);
    }
  };
  const play = async (track: SearchTrack) => {
    if (playing || searching) return;
    setPlaying(track.id);
    setError(null);
    try { await useMediaStore.getState().run("media_play", { trackId: track.id }); }
    catch { setError(t("music.playError")); }
    finally { setPlaying(null); }
  };

  return <Section title={t("music.title")}>
    <form className="music-search-form" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label><span className="field-label">{t("music.searchLabel")}</span>
        <input className="field" type="search" maxLength={200} value={query}
          onChange={event => setQuery(event.target.value)} placeholder={t("music.searchPlaceholder")}/>
      </label>
      <Button type="submit" variant="primary" disabled={searching || !!playing || !query.trim()}>
        {searching ? t("music.searching") : t("music.search")}
      </Button>
    </form>
    {error && <div className="errorbox" role="alert">{error}</div>}
    {searched && tracks.length === 0 && <p role="status" className="field-help">{t("music.noResults")}</p>}
    {tracks.length > 0 && <ul className="music-search-results" aria-label={t("music.results")}>
      {tracks.map(track => <li key={track.id}>
        <div className="music-artwork">{track.artworkUrl && <img src={track.artworkUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/>}</div>
        <div className="music-result-info"><strong>{track.title}</strong><span className="muted">{track.artist}</span></div>
        <Button variant="primary" disabled={!!playing || searching} onClick={() => void play(track)}
          aria-busy={playing === track.id} aria-label={playing === track.id ? t("media.starting") : t("music.playTrack", { title: track.title })}>
          <PlayIcon/>
        </Button>
      </li>)}
    </ul>}
  </Section>;
}
