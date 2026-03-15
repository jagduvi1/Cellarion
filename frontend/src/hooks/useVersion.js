import { useState, useEffect } from 'react';

let cached = null;

export default function useVersion() {
  const [version, setVersion] = useState(cached);

  useEffect(() => {
    if (cached) return;
    fetch('/api/health')
      .then(r => r.json())
      .then(data => {
        cached = data.version || null;
        setVersion(cached);
      })
      .catch(() => {});
  }, []);

  return version;
}
