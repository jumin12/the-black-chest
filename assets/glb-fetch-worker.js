/* Fetches GLB binaries off the main thread; buffers are transferred. */
self.onmessage = async (ev) => {
  const urls = ev.data && ev.data.urls;
  if (!urls || !urls.length) {
    self.postMessage({ done: true });
    return;
  }
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const r = await fetch(url, { cache: 'force-cache', mode: 'cors', credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      const ab = await r.arrayBuffer();
      self.postMessage({ url, buffer: ab }, [ab]);
    } catch (err) {
      self.postMessage({ url, buffer: null });
    }
  }
  self.postMessage({ done: true });
};
