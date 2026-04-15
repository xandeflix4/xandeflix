import { getSessionSnapshot } from './auth';
import { isSupabaseConfigured, supabase } from './supabase';

export interface PlaybackProgressSyncPayload {
  user_id: string;
  media_id: string;
  media_type: string;
  media_title?: string;
  current_time: number;
  duration?: number;
}

/**
 * Manager responsible for batching and throttling playback progress updates to Supabase.
 * Optimized for low-bandwidth environments (Android TV) to prevent database OOM or lock contention.
 */
class PlaybackSyncManager {
  private pendingSync: PlaybackProgressSyncPayload | null = null;
  private lastFlushAt = 0;
  private flushTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL_MS = 30000; // 30 seconds

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.flush(true));
      window.addEventListener('blur', () => this.flush());
    }
  }

  /**
   * Tracks progress locally and schedules a debounced sync to Supabase.
   */
  public track(payload: PlaybackProgressSyncPayload, immediate = false): void {
    if (!isSupabaseConfigured || !payload.user_id || !payload.media_id) return;

    // Update the pending payload with the latest data
    this.pendingSync = {
      ...payload,
      current_time: Math.max(0, Math.floor(payload.current_time)),
      duration: payload.duration ? Math.max(0, Math.floor(payload.duration)) : undefined
    };

    if (immediate) {
      this.flush(true);
      return;
    }

    // If it's time for a periodic sync, trigger it
    const now = Date.now();
    if (now - this.lastFlushAt >= this.FLUSH_INTERVAL_MS) {
      this.flush();
      return;
    }

    // Otherwise, ensure exactly one flush is scheduled
    if (!this.flushTimeoutId) {
      this.flushTimeoutId = setTimeout(() => this.flush(), this.FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Flushes any pending updates to Supabase using the watch_history table (Phase 2).
   */
  public async flush(force = false): Promise<void> {
    if (!this.pendingSync || !isSupabaseConfigured) return;

    // Clear timeout if we are flushing manually
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }

    const payload = this.pendingSync;
    
    // If not forced and we just flushed, skip
    const now = Date.now();
    if (!force && now - this.lastFlushAt < 5000) {
      return;
    }

    this.lastFlushAt = now;
    // We clear pendingSync before the call to ensure no duplicate syncs if network is slow
    const syncData = { ...payload };
    this.pendingSync = null;

    try {
      // PHASE 2 Optimization: Use the dedicated watch_history table instead of JSONB blobs
      const { error } = await supabase.from('watch_history').upsert(
        {
          user_id: syncData.user_id,
          media_id: syncData.media_id,
          media_title: syncData.media_title || 'Unknown',
          media_type: syncData.media_type,
          last_position: syncData.current_time,
          duration: syncData.duration || 0,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id,media_id' }
      );

      if (error) throw error;
      
    } catch (err) {
      console.warn('[PlaybackSync] Failed to sync progress to Supabase:', err);
      // Put back the pending sync if it failed so we can retry on next interval
      if (!this.pendingSync) {
        this.pendingSync = syncData;
      }
    }
  }
}

export const playbackSyncManager = new PlaybackSyncManager();

// Keep the legacy functions for compatibility but route them through the manager
export async function resolvePlaybackProgressUserId(): Promise<string | null> {
  const snapshot = await getSessionSnapshot();
  return (snapshot?.role === 'user' && snapshot?.data?.id) ? snapshot.data.id : null;
}

export function syncPlaybackProgressSilently(payload: PlaybackProgressSyncPayload, immediate = false): void {
  playbackSyncManager.track(payload, immediate);
}
