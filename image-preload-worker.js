/* Warm HTTP cache for PNGs and other static game assets (invoked from index.html at voyage start). */
self.onmessage = function (e) {
  const urls = e.data && e.data.urls;
  if (!Array.isArray(urls)) return;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;
    fetch(url, { cache: 'force-cache', mode: 'cors', credentials: 'same-origin' }).catch(function () {});
  }
};
