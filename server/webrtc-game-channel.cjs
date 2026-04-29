'use strict';

function tryRequireNodeDataChannel() {
  try {
    return require('node-datachannel');
  } catch (err) {
    return null;
  }
}

function parseIceServersFromEnv() {
  const raw = process.env.RTC_ICE_SERVERS;
  if (!raw || !String(raw).trim()) {
    return ['stun:stun.l.google.com:19302'];
  }
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Optional UDP bind / mux for dedicated hosts (see node-datachannel RtcConfig).
 * RTC_PEER_BIND_ADDRESS empty = library default.
 */
function rtcPeerConnectionOptions() {
  const iceServers = parseIceServersFromEnv();
  const opts = { iceServers };
  const bind = process.env.RTC_PEER_BIND_ADDRESS;
  if (bind && String(bind).trim()) opts.bindAddress = String(bind).trim();
  const mux = /^1|true|yes$/i.test(String(process.env.RTC_ENABLE_ICE_UDP_MUX || '').trim());
  if (mux) opts.enableIceUdpMux = true;
  return opts;
}

function createGameRtcBridge(opts) {
  const ndc = tryRequireNodeDataChannel();
  const wantsEnabled = !!(opts && opts.enabled);
  const dualStack = !!(opts && opts.dualStack);
  const iceServers = parseIceServersFromEnv();
  const enabled = wantsEnabled && !!ndc;

  if (!enabled) {
    if (wantsEnabled && !ndc) {
      console.warn('[playground] RTC_GAME_CHANNEL is set but node-datachannel did not load — game-plane WebRTC disabled.');
    }
    return {
      enabled: false,
      dualStack: false,
      publicIceServers: [],
      disposeCaptainRtc() {},
      attachCaptainChannel() {},
      handleSignalingMessage() {},
      sendGameStatePayload() {
        return { sentDc: false };
      }
    };
  }

  function disposeCaptainRtc(ws) {
    const sess = ws._rtcSession;
    delete ws._rtcSession;
    delete ws._rtcGameDc;
    if (!sess) return;
    try {
      if (sess.dc) sess.dc.close();
    } catch (e) {}
    try {
      if (sess.pc) sess.pc.destroy();
    } catch (e2) {}
  }

  function attachCaptainChannel(ws, playerId, onJsonFromCaptain) {
    ws._rtcCaptainPlayerId = playerId;
    ws._rtcOnCaptainJson = onJsonFromCaptain;
  }

  function handleRtcOffer(ws, msg) {
    const sdp = msg && typeof msg.sdp === 'string' ? msg.sdp : '';
    if (!sdp) return;

    disposeCaptainRtc(ws);

    const pcOpts = rtcPeerConnectionOptions();
    const labelPid = ws._rtcCaptainPlayerId != null ? ws._rtcCaptainPlayerId : ws.playerId;
    const pc = new ndc.PeerConnection(`captain-${labelPid}`, pcOpts);
    const sess = { pc, dc: null };
    ws._rtcSession = sess;

    pc.onLocalDescription((localSdp, type) => {
      if (String(type) !== 'Answer') return;
      try {
        ws.send(JSON.stringify({ type: 'rtc_answer', sdp: localSdp }));
      } catch (e) {}
    });

    pc.onLocalCandidate((candidate, mid) => {
      try {
        ws.send(JSON.stringify({
          type: 'rtc_candidate',
          candidate: candidate != null ? String(candidate) : '',
          mid: mid != null ? String(mid) : ''
        }));
      } catch (e) {}
    });

    pc.onDataChannel((dc) => {
      sess.dc = dc;
      ws._rtcGameDc = dc;
      dc.onClosed(() => {
        if (ws._rtcSession && ws._rtcSession.dc === dc) ws._rtcGameDc = null;
      });
      dc.onMessage((data) => {
        let txt;
        try {
          txt = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        } catch (e) {
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(txt);
        } catch (e2) {
          return;
        }
        if (!parsed || typeof parsed !== 'object') return;
        const fn = ws._rtcOnCaptainJson;
        if (typeof fn !== 'function') return;
        try {
          fn(parsed);
        } catch (e3) {
          console.error('[playground] RTC game JSON error:', e3 && e3.message ? e3.message : e3);
        }
      });
    });

    try {
      pc.setRemoteDescription(sdp, 'Offer');
    } catch (e) {
      console.error('[playground] RTC setRemoteDescription failed:', e && e.message ? e.message : e);
      disposeCaptainRtc(ws);
    }
  }

  function handleRtcCandidate(ws, msg) {
    const sess = ws._rtcSession;
    if (!sess || !sess.pc) return;
    const cand = msg && msg.candidate != null ? String(msg.candidate) : '';
    const mid = msg && msg.mid != null && String(msg.mid) !== '' ? String(msg.mid) : '0';
    try {
      sess.pc.addRemoteCandidate(cand, mid);
    } catch (e) {}
  }

  function handleSignalingMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'rtc_offer') {
      handleRtcOffer(ws, msg);
      return;
    }
    if (msg.type === 'rtc_candidate') {
      handleRtcCandidate(ws, msg);
    }
  }

  function sendGameStatePayload(ws, jsonUtf8String) {
    const dc = ws._rtcGameDc;
    if (!dc) return { sentDc: false };
    try {
      if (!dc.isOpen()) return { sentDc: false };
      const ok = dc.sendMessage(jsonUtf8String);
      return { sentDc: !!ok };
    } catch (e) {
      return { sentDc: false };
    }
  }

  return {
    enabled: true,
    dualStack,
    publicIceServers: iceServers.slice(),
    disposeCaptainRtc,
    attachCaptainChannel,
    handleSignalingMessage,
    sendGameStatePayload
  };
}

module.exports = { createGameRtcBridge };
