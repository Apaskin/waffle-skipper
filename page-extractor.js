// page-extractor.js — Runs in the MAIN world (page context)
// This script has access to YouTube's JS variables like ytInitialPlayerResponse
// and the movie_player API. It extracts caption track URLs and sends them
// to the content script (ISOLATED world) via window.postMessage.
//
// Loaded via manifest.json with "world": "MAIN" to bypass YouTube's CSP.

(function () {
  'use strict';

  // Extract caption tracks from YouTube's player data and post them
  function extractAndPostCaptions() {
    var captionTracks = null;

    // Method 1: movie_player.getPlayerResponse() — best for SPA navigations
    // After SPA nav, the player API has the current video's data
    try {
      var player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        var resp = player.getPlayerResponse();
        if (resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer) {
          captionTracks = resp.captions.playerCaptionsTracklistRenderer.captionTracks;
        }
      }
    } catch (e) {
      // Player API not available yet
    }

    // Method 2: ytInitialPlayerResponse global — works on initial page load
    if (!captionTracks || captionTracks.length === 0) {
      try {
        if (window.ytInitialPlayerResponse &&
            window.ytInitialPlayerResponse.captions &&
            window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer) {
          captionTracks = window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
        }
      } catch (e) {
        // Not available
      }
    }

    // Build the message
    var message = { source: 'waffle-skipper-extractor' };

    if (captionTracks && captionTracks.length > 0) {
      message.tracks = captionTracks.map(function (t) {
        return {
          baseUrl: t.baseUrl,
          lang: t.languageCode,
          name: (t.name && t.name.simpleText) || t.languageCode
        };
      });
    } else {
      message.tracks = [];
      message.error = 'No caption tracks found in player data';
    }

    // Post to the content script (ISOLATED world)
    window.postMessage(message, '*');
  }

  // Extract on initial load
  extractAndPostCaptions();

  // Re-extract on YouTube SPA navigations
  document.addEventListener('yt-navigate-finish', function () {
    // Small delay to let the player update with new video data
    setTimeout(extractAndPostCaptions, 1000);
  });

  // Listen for explicit requests from the content script
  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'waffle-skipper-request') {
      extractAndPostCaptions();
    }
  });
})();
