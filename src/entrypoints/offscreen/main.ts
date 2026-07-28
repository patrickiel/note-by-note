import { buildPipeline, type AudioPipeline } from '@/core/audio/pipeline';
import type { OffscreenCommand } from '@/core/messaging/protocol';
import { DEFAULT_PARAMS } from '@/core/model/defaults';
import type { EffectParams } from '@/core/model/types';

/** Tab-capture host: all audio of a captured tab flows through the same
 * DSP pipeline used in direct mode. One capture per tab. */
interface Capture {
  stream: MediaStream;
  ctx: AudioContext;
  pipeline: AudioPipeline;
  params: EffectParams;
}

const captures = new Map<number, Capture>();

async function startCapture(tabId: number, streamId: string): Promise<void> {
  stopCapture(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
      // Chrome's tab-capture constraints are non-standard.
    } as MediaTrackConstraints,
    video: false,
  });
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const source = ctx.createMediaStreamSource(stream);
  const pipeline = await buildPipeline(ctx, source);
  const params = structuredClone(DEFAULT_PARAMS);
  pipeline.applyParams(params);
  captures.set(tabId, { stream, ctx, pipeline, params });

  // If the tab stops being captured (closed / user cancels), clean up.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => stopCapture(tabId));
}

function stopCapture(tabId: number): void {
  const capture = captures.get(tabId);
  if (!capture) return;
  captures.delete(tabId);
  capture.pipeline.dispose();
  for (const track of capture.stream.getTracks()) track.stop();
  void capture.ctx.close();
}

browser.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (value: unknown) => void) => {
    const cmd = message as OffscreenCommand & { type: string };
    if (cmd?.target !== 'offscreen') return;
    switch (cmd.type) {
      case 'capture.start':
        startCapture(cmd.tabId, cmd.streamId).then(
          () => sendResponse({ ok: true }),
          (err) => sendResponse({ ok: false, error: String(err) }),
        );
        return true; // async response
      case 'capture.stop':
        stopCapture(cmd.tabId);
        sendResponse({ ok: true, active: captures.size });
        break;
      case 'capture.query':
        sendResponse({ capturing: captures.has(cmd.tabId), active: captures.size });
        break;
      case 'params': {
        const capture = captures.get(cmd.tabId);
        if (capture) {
          Object.assign(capture.params, cmd.patch);
          capture.pipeline.applyParams(capture.params);
        }
        sendResponse({ ok: !!capture });
        break;
      }
      case 'volume': {
        const capture = captures.get(cmd.tabId);
        capture?.pipeline.setVolume(cmd.volume);
        sendResponse({ ok: !!capture });
        break;
      }
    }
    return undefined;
  },
);
