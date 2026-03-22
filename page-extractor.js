// page-extractor.js — Runs in the MAIN world at document_start
//
// Intercepts YouTube's own XHR/fetch caption requests to capture transcript data.
// YouTube's player fetches captions via /api/timedtext — we patch XMLHttpRequest
// and fetch BEFORE YouTube's scripts load to capture those responses.
//
// This is the only reliable approach because YouTube's caption URLs require
// browser-level session context that can't be replicated from extension code.

(function () {
  'use strict';

  // Store captured transcript data, keyed by video ID
  var capturedTranscripts = {};
  // Track in-flight transcript fetches to avoid duplicate requests
  var capturePromises = {};
  // Known public Innertube key used when page config key is missing.
  var YT_INNERTUBE_API_KEY_CANDIDATES = [
    'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
  ];

  // ============================================================
  // XMLHttpRequest Interception
  // ============================================================

  var OrigXHR = window.XMLHttpRequest;
  var origOpen = OrigXHR.prototype.open;
  var origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url) {
    // Flag timedtext requests so we can capture the response
    if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1) {
      this._waffleTimedtextUrl = url;
    }
    return origOpen.apply(this, arguments);
  };

  OrigXHR.prototype.send = function () {
    var xhr = this;
    var url = this._waffleTimedtextUrl;

    if (url) {
      xhr.addEventListener('load', function () {
        if (xhr.status === 200 && xhr.responseText && xhr.responseText.length > 100) {
          handleTimedtextResponse(url, xhr.responseText);
        }
      });
    }

    return origSend.apply(this, arguments);
  };

  // ============================================================
  // Fetch Interception
  // ============================================================

  var origFetch = window.fetch;
  window.fetch = function () {
    var url = (arguments[0] && typeof arguments[0] === 'string') ? arguments[0]
      : (arguments[0] && arguments[0].url) ? arguments[0].url : '';

    if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1) {
      var captureUrl = url;
      return origFetch.apply(this, arguments).then(function (response) {
        var clone = response.clone();
        clone.text().then(function (text) {
          if (response.ok && text.length > 100) {
            handleTimedtextResponse(captureUrl, text);
          }
        });
        return response;
      });
    }
    return origFetch.apply(this, arguments);
  };

  // ============================================================
  // Response Handling
  // ============================================================

  function handleTimedtextResponse(url, responseText) {
    var videoId = extractVideoIdFromUrl(url);
    if (!videoId) return;

    // P0-1 fix: skip non-English captions — sending non-English text to Claude's
    // English-only classifier produces garbage results. Only filter when we can
    // positively identify a non-English lang= parameter; unknown language passes through.
    var lang = extractLanguageFromTimedtextUrl(url);
    if (lang !== null && lang !== 'en' && lang.indexOf('en') !== 0) {
      return;
    }

    // Already captured this video — skip
    if (capturedTranscripts[videoId]) return;

    // Try JSON parse (json3 format)
    try {
      var data = JSON.parse(responseText);
      if (data.events && data.events.length > 0) {
        capturedTranscripts[videoId] = data;
        postTranscript(videoId, data, 'json');
        return;
      }
    } catch (e) {}

    // Try XML parse (default/srv3 format)
    try {
      if (responseText.trim().charAt(0) === '<') {
        var parsed = parseXmlTranscript(responseText);
        if (parsed && parsed.events.length > 0) {
          capturedTranscripts[videoId] = parsed;
          postTranscript(videoId, parsed, 'xml');
          return;
        }
      }
    } catch (e) {}
  }

  function selectBestTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    // P0-1 fix: do NOT fall back to tracks[0] — caller must decide what to do
    // when tracks exist but none are in English.
    return tracks.find(function (t) { return t && t.languageCode === 'en'; })
      || tracks.find(function (t) { return t && t.languageCode && t.languageCode.indexOf('en') === 0; })
      || null;
  }

  // Extract the 'lang' parameter from a YouTube timedtext URL.
  // Returns null if the parameter is absent (unknown language — don't block).
  function extractLanguageFromTimedtextUrl(url) {
    try {
      var match = url.match(/[?&]lang=([^&]+)/i);
      return match ? match[1].toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  function dedupeTracks(tracks) {
    var seen = {};
    var unique = [];
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      if (!track || !track.baseUrl) continue;
      var key = String(track.baseUrl);
      if (seen[key]) continue;
      seen[key] = true;
      unique.push(track);
    }
    return unique;
  }

  function extractTracksFromPlayerResponse(playerResponse) {
    try {
      var tracks = playerResponse
        && playerResponse.captions
        && playerResponse.captions.playerCaptionsTracklistRenderer
        && playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
      return Array.isArray(tracks) ? tracks : [];
    } catch (e) {
      return [];
    }
  }

  function buildTimedtextUrls(baseUrl) {
    if (!baseUrl) return [];
    var urls = [baseUrl];
    var json3Url;

    if (baseUrl.indexOf('fmt=') !== -1) {
      json3Url = baseUrl.replace(/([?&])fmt=[^&]*/i, '$1fmt=json3');
    } else {
      json3Url = baseUrl + '&fmt=json3';
    }

    if (json3Url !== baseUrl) {
      urls.push(json3Url);
    }

    // Deduplicate while preserving order
    var seen = {};
    return urls.filter(function (u) {
      if (!u || seen[u]) return false;
      seen[u] = true;
      return true;
    });
  }

  function parseTranscriptResponse(text) {
    try {
      var json = JSON.parse(text);
      if (json && json.events && json.events.length > 0) return json;
    } catch (e) {}

    try {
      if (text && text.trim().charAt(0) === '<') {
        return parseXmlTranscript(text);
      }
    } catch (e) {}

    return null;
  }

  function decodeXmlEntities(text) {
    return (text || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function getCaptionTracksFromPlayerResponse() {
    var allTracks = [];

    try {
      if (window.ytInitialPlayerResponse) {
        allTracks = allTracks.concat(extractTracksFromPlayerResponse(window.ytInitialPlayerResponse));
      }
    } catch (e) {}

    try {
      if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.player_response) {
        var cfgResponse = JSON.parse(window.ytplayer.config.args.player_response);
        allTracks = allTracks.concat(extractTracksFromPlayerResponse(cfgResponse));
      }
    } catch (e) {}

    try {
      var moviePlayer = document.getElementById('movie_player');
      if (moviePlayer && typeof moviePlayer.getPlayerResponse === 'function') {
        allTracks = allTracks.concat(extractTracksFromPlayerResponse(moviePlayer.getPlayerResponse()));
      }
      if (moviePlayer && typeof moviePlayer.getOption === 'function') {
        var tracklist = moviePlayer.getOption('captions', 'tracklist');
        if (tracklist && Array.isArray(tracklist.captionTracks)) {
          allTracks = allTracks.concat(tracklist.captionTracks);
        }
      }
    } catch (e) {}

    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        var ytcfgResp = window.ytcfg.get('PLAYER_RESPONSE');
        if (ytcfgResp) {
          if (typeof ytcfgResp === 'string') {
            ytcfgResp = JSON.parse(ytcfgResp);
          }
          allTracks = allTracks.concat(extractTracksFromPlayerResponse(ytcfgResp));
        }
      }
    } catch (e) {}

    return dedupeTracks(allTracks);
  }

  function dedupeStrings(values) {
    var seen = {};
    var unique = [];
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (!value || seen[value]) continue;
      seen[value] = true;
      unique.push(value);
    }
    return unique;
  }

  function getInnertubeApiKeyFromPage() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        var cfgKey = window.ytcfg.get('INNERTUBE_API_KEY');
        if (cfgKey) return cfgKey;
      }
    } catch (e) {}

    try {
      var scripts = document.querySelectorAll('script');
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i] && scripts[i].textContent;
        if (!text || text.indexOf('INNERTUBE_API_KEY') === -1) continue;
        var match = text.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
        if (match && match[1]) return match[1];
      }
    } catch (e) {}

    return null;
  }

  async function fetchCaptionTracksViaInnertube(videoId) {
    if (!videoId) return [];

    var pageKey = getInnertubeApiKeyFromPage();
    var keyCandidates = dedupeStrings([pageKey].concat(YT_INNERTUBE_API_KEY_CANDIDATES));
    var requestVariants = [
      {
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '3',
          'X-YouTube-Client-Version': '20.10.38'
        },
        body: {
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38'
            }
          },
          videoId: videoId
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': '2.20260317.01.00'
        },
        body: {
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20260317.01.00',
              hl: 'en'
            }
          },
          videoId: videoId
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        body: {
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38'
            }
          },
          videoId: videoId
        }
      }
    ];

    for (var k = 0; k < keyCandidates.length; k++) {
      var key = keyCandidates[k];
      for (var v = 0; v < requestVariants.length; v++) {
        try {
          var variant = requestVariants[v];
          var response = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + encodeURIComponent(key), {
            method: 'POST',
            headers: variant.headers,
            body: JSON.stringify(variant.body),
            credentials: 'include'
          });
          if (!response.ok) continue;

          var data = await response.json();
          var tracks = extractTracksFromPlayerResponse(data);
          if (tracks.length > 0) {
            return dedupeTracks(tracks);
          }
        } catch (e) {}
      }
    }

    return [];
  }

  async function fetchTranscriptFromTrack(track) {
    if (!track || !track.baseUrl) return null;

    var candidateUrls = buildTimedtextUrls(track.baseUrl);
    for (var u = 0; u < candidateUrls.length; u++) {
      var trackUrl = candidateUrls[u];
      try {
        var response = await fetch(trackUrl, { credentials: 'include' });
        if (!response.ok) continue;

        var text = await response.text();
        var parsed = parseTranscriptResponse(text);
        if (parsed && parsed.events && parsed.events.length > 0) {
          return parsed;
        }
      } catch (e) {}
    }

    return null;
  }

  async function tryCaptureFromTrackList(videoId, tracks, methodName) {
    if (!tracks || tracks.length === 0) return null;

    var uniqueTracks = dedupeTracks(tracks);
    var bestTrack = selectBestTrack(uniqueTracks);
    var orderedTracks = [];

    if (bestTrack) {
      orderedTracks.push(bestTrack);
    }
    for (var i = 0; i < uniqueTracks.length; i++) {
      if (uniqueTracks[i] === bestTrack) continue;
      orderedTracks.push(uniqueTracks[i]);
    }

    for (var t = 0; t < orderedTracks.length; t++) {
      var parsed = await fetchTranscriptFromTrack(orderedTracks[t]);
      if (parsed && parsed.events && parsed.events.length > 0) {
        capturedTranscripts[videoId] = parsed;
        postTranscript(videoId, parsed, methodName);
        return parsed;
      }
    }

    return null;
  }

  function tryCaptureFromPlayerResponse(videoId) {
    if (!videoId) {
      return Promise.resolve(null);
    }
    if (capturedTranscripts[videoId]) {
      return Promise.resolve(capturedTranscripts[videoId]);
    }
    if (capturePromises[videoId]) {
      return capturePromises[videoId];
    }

    capturePromises[videoId] = (async function () {
      var maxAttempts = 22; // ~15s at 700ms intervals
      try {
        for (var attempt = 1; attempt <= maxAttempts; attempt++) {
          if (capturedTranscripts[videoId]) {
            return capturedTranscripts[videoId];
          }

          var tracks = getCaptionTracksFromPlayerResponse();
          var parsedFromPlayer = await tryCaptureFromTrackList(videoId, tracks, 'playerState');
          if (parsedFromPlayer) {
            return parsedFromPlayer;
          }

          // Some videos expose empty timedtext URLs in player state; query Innertube
          // directly every few attempts to obtain a valid caption URL.
          if (attempt === 1 || attempt % 4 === 0) {
            var innertubeTracks = await fetchCaptionTracksViaInnertube(videoId);
            var parsedFromInnertube = await tryCaptureFromTrackList(videoId, innertubeTracks, 'innertube');
            if (parsedFromInnertube) {
              return parsedFromInnertube;
            }
          }

          await new Promise(function (resolve) { setTimeout(resolve, 700); });
        }
        return null;
      } catch (e) {
        return null;
      } finally {
        delete capturePromises[videoId];
      }
    })();

    return capturePromises[videoId];
  }

  function extractVideoIdFromUrl(url) {
    try {
      var match = url.match(/[?&]v=([^&]+)/);
      return match ? match[1] : null;
    } catch (e) {
      return null;
    }
  }

  function getCurrentVideoId() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return params.get('v');
    } catch (e) {
      return null;
    }
  }

  function postTranscript(videoId, data, method) {
    // P1-7 fix: target specific origin instead of '*' to prevent other frames
    // (e.g. ad iframes) from intercepting transcript data.
    window.postMessage({
      source: 'waffle-skipper-extractor',
      transcript: data,
      tracks: [],
      videoId: videoId,
      method: method
    }, 'https://www.youtube.com');
  }

  function parseXmlTranscript(xmlText) {
    try {
      var events = [];
      var seenStarts = {};

      function collectEvents(regex, isMs) {
        var match;
        while ((match = regex.exec(xmlText)) !== null) {
          var attrs = match[1] || '';
          var body = (match[2] || '').replace(/<[^>]+>/g, '');
          var startMatch = attrs.match(isMs ? /(?:^|\s)t="([^"]+)"/ : /(?:^|\s)start="([^"]+)"/);
          var durMatch = attrs.match(isMs ? /(?:^|\s)d="([^"]+)"/ : /(?:^|\s)dur="([^"]+)"/);
          if (!startMatch) continue;

          var startRaw = parseFloat(startMatch[1] || '0');
          var durRaw = parseFloat(durMatch ? durMatch[1] : '0');
          if (!isFinite(startRaw)) continue;
          if (!isFinite(durRaw)) durRaw = 0;

          var startMs = isMs ? Math.round(startRaw) : Math.round(startRaw * 1000);
          var durationMs = isMs ? Math.round(durRaw) : Math.round(durRaw * 1000);
          if (startMs < 0) startMs = 0;
          if (durationMs < 0) durationMs = 0;

          // Avoid duplicate events when both <text> and <p> are present.
          var dedupeKey = startMs + '|' + durationMs + '|' + body;
          if (seenStarts[dedupeKey]) continue;
          seenStarts[dedupeKey] = true;

          var cleanText = decodeXmlEntities(body).replace(/\s+/g, ' ').trim();
          if (!cleanText) continue;

          events.push({
            tStartMs: startMs,
            dDurationMs: durationMs,
            segs: [{ utf8: cleanText }]
          });
        }
      }

      collectEvents(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, false);
      collectEvents(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, true);
      if (events.length === 0) return null;

      return { events: events };
    } catch (e) { return null; }
  }

  // ============================================================
  // Content Script Communication
  // ============================================================

  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'waffle-skipper-request') {
      var vid = event.data.videoId;
      if (vid && capturedTranscripts[vid]) {
        postTranscript(vid, capturedTranscripts[vid], 'cache');
      } else {
        tryCaptureFromPlayerResponse(vid).then(function (captured) {
          if (!captured) {
            window.postMessage({
              source: 'waffle-skipper-extractor',
              transcript: null,
              tracks: [],
              videoId: vid,
              error: 'Not captured yet'
            }, 'https://www.youtube.com'); // P1-7: specific target origin
          }
        });
      }
    }
  });

  function scheduleCaptureForCurrentVideo() {
    var videoId = getCurrentVideoId();
    if (videoId) {
      tryCaptureFromPlayerResponse(videoId);
    }
  }

  document.addEventListener('yt-navigate-finish', scheduleCaptureForCurrentVideo);
  window.addEventListener('popstate', scheduleCaptureForCurrentVideo);

  // Best-effort proactive capture for direct page loads
  setTimeout(scheduleCaptureForCurrentVideo, 1200);
  setTimeout(scheduleCaptureForCurrentVideo, 2600);
  setTimeout(scheduleCaptureForCurrentVideo, 4500);
})();
