// Throwaway end-to-end check for the song request flow. Stubs the YouTube API
// at the https layer so no key or network is needed.
const https = require('https');
const { EventEmitter } = require('events');

const VIDEOS = {
  aaaaaaaaaaa: { dur: 'PT3M30S', embeddable: true, title: 'Good Song' },
  bbbbbbbbbbb: { dur: 'PT3M10S', embeddable: true, title: 'Second Song' },
  ccccccccccc: { dur: 'PT4M00S', embeddable: false, title: 'Blocked Embed' },
  ddddddddddd: { dur: 'PT45M00S', embeddable: true, title: 'Way Too Long' },
  eeeeeeeeeee: { dur: 'PT2M00S', embeddable: true, title: 'Filler Track' },
  // An in-progress live stream reports a duration with no time section at all.
  fffffffffff: { dur: 'P0D', embeddable: true, title: 'Live Radio' },
  // A long-running live archive, reported in days.
  ggggggggggg: { dur: 'P1407DT10H11M52S', embeddable: true, title: 'Lofi Archive' },
};

const realGet = https.get;
https.get = (url, opts, cb) => {
  if (typeof url !== 'string' || !url.includes('googleapis.com/youtube')) {
    return realGet(url, opts, cb);
  }
  const callback = typeof opts === 'function' ? opts : cb;
  const id = /[?&]id=([^&]+)/.exec(url)[1];
  const v = VIDEOS[id];
  const body = JSON.stringify({
    items: v
      ? [{
          snippet: { title: v.title, channelTitle: 'Test Channel' },
          contentDetails: { duration: v.dur },
          status: { embeddable: v.embeddable },
        }]
      : [],
  });
  const res = new EventEmitter();
  res.statusCode = 200;
  setImmediate(() => { callback(res); res.emit('data', body); res.emit('end'); });
  return new EventEmitter();
};

const os = require('os');
const fsNode = require('fs');
// Never the real filler-songs.json -- a test run must not touch curated data.
const TEST_FILLER_FILE = require('path').join(os.tmpdir(), `filler-test-${process.pid}.json`);
process.env.FILLER_SONGS_FILE = TEST_FILLER_FILE;
const cleanup = () => { try { fsNode.unlinkSync(TEST_FILLER_FILE); } catch {} };
process.on('exit', cleanup);

process.env.YOUTUBE_API_KEY = 'test-key';
process.env.HTTP_PORT = '8090';
process.env.WS_PORT = '8091';
process.env.MOCK = '0';
process.env.TIKTOK_USERNAME = '___offline_test___';

const server = require('./server.js');

const WebSocket = require('ws');
const link = (id) => `https://www.youtube.com/watch?v=${id}`;

setTimeout(() => {
  const ws = new WebSocket('ws://localhost:8091');
  let state = null;
  const failures = [];
  ws.on('message', (raw) => {
    const d = JSON.parse(raw);
    if (d.type === 'song-state') state = d;
  });

  const send = (m) => ws.send(JSON.stringify(m));
  const req = (user, id) =>
    server.handleSongRequestComment(user, user, `/music ${link(id)}`);
  const bareReq = (user, id) =>
    server.handleSongRequestComment(user, user, `ขอเพลงนี้ ${link(id)}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (label, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failures.push(label);
  };

  ws.on('open', async () => {
    await wait(200);
    check('starts disabled', state.enabled === false);
    check('has api key', state.hasApiKey === true);
    // Requests while disabled are ignored entirely.
    await req('u1', 'aaaaaaaaaaa');
    await wait(100);
    check('ignores requests while disabled', state.pending.length === 0);

    send({ type: 'set-song-enabled', enabled: true });
    await wait(100);

    await bareReq('u1', 'aaaaaaaaaaa');
    await wait(150);
    check('ignores a link without the /music command', state.pending.length === 0);

    await req('u1', 'aaaaaaaaaaa');
    await wait(150);
    check('queues a valid request', state.pending.length === 1);
    check('captured title', state.pending[0].title === 'Good Song');

    await req('u1', 'bbbbbbbbbbb');
    await wait(150);
    check('one pending per viewer', state.pending.length === 1);

    await req('u2', 'aaaaaaaaaaa');
    await wait(150);
    check('refuses duplicate videoId', state.pending.length === 1);

    await req('u2', 'ccccccccccc');
    await wait(150);
    check('refuses un-embeddable', state.pending.length === 1);

    await req('u2', 'ddddddddddd');
    await wait(150);
    check('refuses over-length', state.pending.length === 1);

    await req('u2', 'fffffffffff');
    await wait(150);
    check('refuses in-progress live stream (P0D)', state.pending.length === 1);

    await req('u2', 'ggggggggggg');
    await wait(150);
    check('refuses day-length duration', state.pending.length === 1);

    // Approving with nothing playing should start it immediately.
    send({ type: 'song-approve', id: state.pending[0].id });
    await wait(150);
    check('approve starts playback', state.nowPlaying && state.nowPlaying.title === 'Good Song');
    check('pending drained', state.pending.length === 0);

    // u1 may ask again now that theirs resolved.
    await req('u1', 'bbbbbbbbbbb');
    await wait(150);
    check('viewer may ask again after resolution', state.pending.length === 1);

    send({ type: 'song-approve', id: state.pending[0].id });
    await wait(150);
    check('second approval queues behind', state.approved.length === 1);
    check('current song keeps playing', state.nowPlaying.title === 'Good Song');

    send({ type: 'filler-add', link: link('eeeeeeeeeee') });
    await wait(200);
    check('filler added', state.fillers.length === 1);

    // Nothing plays on its own: a filler sitting in an idle session stays
    // silent until the streamer explicitly starts it.
    send({ type: 'song-start' });
    await wait(150);
    check('song-start is a no-op while a song plays', state.nowPlaying.title === 'Good Song');

    // Ending the current song advances to the approved one, not the filler.
    send({ type: 'song-ended', id: state.nowPlaying.id });
    await wait(150);
    check('viewer request beats filler', state.nowPlaying.title === 'Second Song');

    // Queue is empty now, so the filler takes over and is NOT consumed.
    send({ type: 'song-ended', id: state.nowPlaying.id });
    await wait(150);
    check('falls back to filler', state.nowPlaying.title === 'Filler Track');
    check('filler marked as such', state.nowPlaying.isFiller === true);
    check('filler not consumed', state.fillers.length === 1);

    send({ type: 'song-ended', id: state.nowPlaying.id });
    await wait(150);
    check('filler repeats when still empty', state.nowPlaying.title === 'Filler Track');

    // A stale widget must not be able to skip the live song.
    const liveId = state.nowPlaying.id;
    send({ type: 'song-ended', id: 'stale-id' });
    await wait(150);
    check('ignores stale song-ended', state.nowPlaying.id === liveId);

    send({ type: 'set-song-enabled', enabled: false });
    await wait(150);
    check('disabling clears queues', state.pending.length === 0 && state.approved.length === 0);
    check('disabling leaves current song alone', state.nowPlaying !== null);

    send({ type: 'song-stop' });
    await wait(150);
    check('stop returns to idle', state.nowPlaying === null);

    send({ type: 'song-start' });
    await wait(150);
    check('song-start plays a filler from idle', state.nowPlaying && state.nowPlaying.isFiller === true);

    console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
    ws.close();
    process.exit(failures.length === 0 ? 0 : 1);
  });
}, 500);
