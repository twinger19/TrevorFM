// In-page player via the Spotify Web Playback SDK. The page registers itself
// as a Spotify Connect device, so the rest of the app treats it like any other
// device: play/queue/volume all go through the same Web API calls.
import { getAccessToken } from "./auth.js";
import { settings } from "./config.js";

let player = null;

export function initBrowserPlayer({ onReady, onError }) {
  const boot = () => {
    if (player) return;
    player = new Spotify.Player({
      name: `${settings.stationName} (this tab)`,
      getOAuthToken: (cb) => getAccessToken().then(cb).catch((e) => onError(e.message)),
      volume: settings.playVolume / 100,
    });
    player.addListener("ready", ({ device_id }) => onReady(device_id));
    player.addListener("initialization_error", ({ message }) => onError(message));
    player.addListener("authentication_error", ({ message }) =>
      onError(`${message} (reconnect Spotify in Settings to grant streaming permission)`));
    player.addListener("account_error", ({ message }) => onError(`${message} (Premium required)`));
    player.connect();
  };
  if (window.Spotify) boot();
  else window.onSpotifyWebPlaybackSDKReady = boot;
}

// Must be called from a user gesture (the Start click) so the browser
// allows audio to begin.
export function activateBrowserPlayback() {
  player?.activateElement?.();
}
