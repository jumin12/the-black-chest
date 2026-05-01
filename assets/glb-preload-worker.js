/* Prefetch `.glb` URLs into the HTTP cache quickly (parallel bursts). Posted from index.html at boot / MP connect. */
self.onmessage = function (e) {
  const data = e && e.data;
  const urls = data && data.urls;
  if (!Array.isArray(urls) || !urls.length) return;
  var parallel = Number(data.parallel);
  if (!Number.isFinite(parallel) || parallel < 1) parallel = 8;
  if (parallel > 16) parallel = 16;
  var i = 0;

  function runBatch() {
    var slice = urls.slice(i, i + parallel);
    i += parallel;
    if (!slice.length) return;
    var pending = slice.map(function (url) {
      if (!url) return Promise.resolve();
      return fetch(url, { cache: 'force-cache', mode: 'cors', credentials: 'same-origin' }).catch(function () {});
    });
    Promise.all(pending).then(function () {
      if (i < urls.length) runBatch();
    });
  }
  runBatch();
};
