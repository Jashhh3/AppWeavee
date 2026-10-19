import { useEffect, useState } from 'react';

export type ProjectPreviewData = { projectName?: string; status?: string; previewUrl?: string; fallback?: string };

/** Minimal host bridge for MCP Apps tool output. It never assumes localhost is reachable from an iframe. */
export function McpAppsBridge({ initial }: { initial?: ProjectPreviewData }) {
  const [data, setData] = useState<ProjectPreviewData>(initial ?? {});
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'appweave:project-preview') setData(event.data.data ?? event.data);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return <section aria-label="MCP Apps project preview">
    <strong>{data.projectName ?? 'Project'} preview</strong>
    <p>Status: {data.status ?? 'waiting for preview data'}</p>
    {data.previewUrl && <p>{data.fallback ?? 'The embedded preview may be unavailable from this MCP host.'} <a href={data.previewUrl} target="_blank" rel="noreferrer">Open preview link</a></p>}
  </section>;
}
