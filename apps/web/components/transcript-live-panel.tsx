'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ScanText, Languages } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { wsSubscribe, wsAddListener } from '@/lib/ws';

interface TranscriptEvent {
  type: 'channel.transcript';
  channelId: string;
  language: string;
  text: string;
  words?: Array<{ t: number; d: number; w: string }>;
  at?: number;
}

interface CaptionLine { text: string; language: string; at: number }

/**
 * Live captions panel for the multiviewer. Subscribes to a specific channel's
 * transcript stream over the WebSocket. Keeps the last N lines and auto-scrolls.
 */
export function TranscriptLivePanel({ channelId, channelName }: { channelId: string; channelName?: string }) {
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    wsSubscribe(channelId);
    const handler = (m: unknown) => {
      const ev = m as TranscriptEvent;
      if (ev?.type !== 'channel.transcript' || ev.channelId !== channelId) return;
      setLines((prev) => {
        const next = [...prev, { text: ev.text, language: ev.language, at: ev.at ?? Date.now() }];
        return next.slice(-80);
      });
    };
    const off = wsAddListener(handler);
    return off;
  }, [channelId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [lines]);

  const langsSeen = useMemo(() => Array.from(new Set(lines.map((l) => l.language))), [lines]);

  return (
    <div className="flex flex-col h-full min-h-0 rounded-lg border border-border bg-white">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <ScanText className="h-3.5 w-3.5 text-brand" />
        <div className="text-xs font-medium truncate">{channelName ?? 'Transcript'}</div>
        <div className="flex-1" />
        {langsSeen.map((l) => (
          <Badge key={l} variant="cyan" className="gap-1"><Languages className="h-2.5 w-2.5" />{l.toUpperCase()}</Badge>
        ))}
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto scrollbar-thin px-3 py-2 space-y-1.5 text-sm leading-relaxed">
        {lines.length === 0 ? (
          <div className="text-xs text-muted-2 italic">Waiting for captions… (needs the transcription worker running)</div>
        ) : lines.map((l, i) => (
          <div key={i}>
            <span className="text-[10px] text-muted-2 font-mono mr-2">{new Date(l.at).toLocaleTimeString().slice(0, 5)}</span>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
