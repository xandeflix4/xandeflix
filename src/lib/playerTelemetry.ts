import { getSessionSnapshot } from './auth';
import { supabase, isSupabaseConfigured } from './supabase';

export type PlayerTelemetryExitReason =
  | 'close'
  | 'channel_switch'
  | 'manual_retry'
  | 'fatal_error'
  | 'unmount';

export interface PlayerTelemetryReport {
  mediaId: string;
  mediaTitle: string;
  mediaCategory?: string;
  mediaType: string;
  streamHost?: string;
  strategy: string;
  sessionSeconds: number;
  watchSeconds: number;
  bufferSeconds: number;
  bufferEventCount: number;
  stallRecoveryCount: number;
  errorRecoveryCount: number;
  endedRecoveryCount: number;
  manualRetryCount: number;
  qualityFallbackCount: number;
  fatalErrorCount: number;
  sampled: boolean;
  exitReason: PlayerTelemetryExitReason;
}

export function sendPlayerTelemetryReport(report: PlayerTelemetryReport): void {
  if (typeof window === 'undefined' || !isSupabaseConfigured) return;

  void getSessionSnapshot()
    .then(async (snapshot) => {
      if (!snapshot || snapshot.role !== 'user' || !snapshot.data) {
        return;
      }

      const { error } = await supabase.from('player_telemetry_reports').insert({
        user_id: snapshot.data.id,
        session_role: snapshot.role,
        media_id: report.mediaId,
        media_title: report.mediaTitle,
        media_category: report.mediaCategory || '',
        media_type: report.mediaType || 'live',
        stream_host: report.streamHost || '',
        strategy: report.strategy,
        session_seconds: Math.max(0, Math.round(report.sessionSeconds || 0)),
        watch_seconds: Math.max(0, Math.round(report.watchSeconds || 0)),
        buffer_seconds: Math.max(0, Math.round(report.bufferSeconds || 0)),
        buffer_event_count: Math.max(0, Math.round(report.bufferEventCount || 0)),
        stall_recovery_count: Math.max(0, Math.round(report.stallRecoveryCount || 0)),
        error_recovery_count: Math.max(0, Math.round(report.errorRecoveryCount || 0)),
        ended_recovery_count: Math.max(0, Math.round(report.endedRecoveryCount || 0)),
        manual_retry_count: Math.max(0, Math.round(report.manualRetryCount || 0)),
        quality_fallback_count: Math.max(0, Math.round(report.qualityFallbackCount || 0)),
        fatal_error_count: Math.max(0, Math.round(report.fatalErrorCount || 0)),
        sampled: Boolean(report.sampled),
        exit_reason: report.exitReason,
      });

      if (error) {
        throw error;
      }
    })
    .catch((error) => {
      console.warn('[Telemetry] Falha ao enviar resumo do player:', error);
    });
}
