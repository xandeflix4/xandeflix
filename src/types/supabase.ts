export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      global_media_overrides: {
        Row: {
          created_at: string;
          created_by: string | null;
          override_data: Json;
          title_match: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          override_data?: Json;
          title_match: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          override_data?: Json;
          title_match?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      favorites: {
        Row: {
          created_at: string;
          media_id: string;
          media_title: string;
          media_type: string;
          tmdb_id: number | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          media_id: string;
          media_title: string;
          media_type?: string;
          tmdb_id?: number | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          media_id?: string;
          media_title?: string;
          media_type?: string;
          tmdb_id?: number | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "favorites_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "xandeflix_users";
            referencedColumns: ["id"];
          }
        ];
      };
      player_telemetry_reports: {
        Row: {
          buffer_event_count: number;
          buffer_seconds: number;
          created_at: string;
          ended_recovery_count: number;
          error_recovery_count: number;
          exit_reason: string;
          fatal_error_count: number;
          id: number;
          manual_retry_count: number;
          media_category: string;
          media_id: string;
          media_title: string;
          media_type: string;
          quality_fallback_count: number;
          sampled: boolean;
          session_role: string;
          session_seconds: number;
          stall_recovery_count: number;
          strategy: string;
          stream_host: string;
          user_id: string | null;
          watch_seconds: number;
        };
        Insert: {
          buffer_event_count?: number;
          buffer_seconds?: number;
          created_at?: string;
          ended_recovery_count?: number;
          error_recovery_count?: number;
          exit_reason?: string;
          fatal_error_count?: number;
          id?: never;
          manual_retry_count?: number;
          media_category?: string;
          media_id: string;
          media_title: string;
          media_type?: string;
          quality_fallback_count?: number;
          sampled?: boolean;
          session_role?: string;
          session_seconds?: number;
          stall_recovery_count?: number;
          strategy?: string;
          stream_host?: string;
          user_id?: string | null;
          watch_seconds?: number;
        };
        Update: {
          buffer_event_count?: number;
          buffer_seconds?: number;
          created_at?: string;
          ended_recovery_count?: number;
          error_recovery_count?: number;
          exit_reason?: string;
          fatal_error_count?: number;
          id?: never;
          manual_retry_count?: number;
          media_category?: string;
          media_id?: string;
          media_title?: string;
          media_type?: string;
          quality_fallback_count?: number;
          sampled?: boolean;
          session_role?: string;
          session_seconds?: number;
          stall_recovery_count?: number;
          strategy?: string;
          stream_host?: string;
          user_id?: string | null;
          watch_seconds?: number;
        };
        Relationships: [];
      };
      playlist_catalog_snapshots: {
        Row: {
          category_count: number;
          created_at: string;
          epg_url: string | null;
          generated_at: string;
          item_count: number;
          playlist_url: string;
          snapshot: Json;
          source_hash: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          category_count?: number;
          created_at?: string;
          epg_url?: string | null;
          generated_at?: string;
          item_count?: number;
          playlist_url?: string;
          snapshot?: Json;
          source_hash?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          category_count?: number;
          created_at?: string;
          epg_url?: string | null;
          generated_at?: string;
          item_count?: number;
          playlist_url?: string;
          snapshot?: Json;
          source_hash?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_preferences: {
        Row: {
          created_at: string;
          favorites: Json;
          playback_progress: Json;
          updated_at: string;
          user_id: string;
          watch_history: Json;
        };
        Insert: {
          created_at?: string;
          favorites?: Json;
          playback_progress?: Json;
          updated_at?: string;
          user_id: string;
          watch_history?: Json;
        };
        Update: {
          created_at?: string;
          favorites?: Json;
          playback_progress?: Json;
          updated_at?: string;
          user_id?: string;
          watch_history?: Json;
        };
        Relationships: [];
      };
      watch_history: {
        Row: {
          created_at: string;
          duration: number;
          id: number;
          last_position: number;
          media_id: string;
          media_title: string;
          media_type: string;
          tmdb_id: number | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          duration?: number;
          id?: never;
          last_position?: number;
          media_id: string;
          media_title: string;
          media_type?: string;
          tmdb_id?: number | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          duration?: number;
          id?: never;
          last_position?: number;
          media_id?: string;
          media_title?: string;
          media_type?: string;
          tmdb_id?: number | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "watch_history_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "xandeflix_users";
            referencedColumns: ["id"];
          }
        ];
      };
      xandeflix_users: {
        Row: {
          access_id: string | null;
          adult_password: string | null;
          adult_totp_enabled: boolean;
          adult_totp_secret: string | null;
          auth_user_id: string | null;
          category_overrides: Json;
          created_at: string;
          email: string | null;
          hidden_categories: string[];
          id: string;
          is_blocked: boolean;
          last_access: string | null;
          media_overrides: Json;
          name: string;
          password: string | null;
          playlist_url: string;
          role: 'admin' | 'user';
          updated_at: string;
          username: string | null;
        };
        Insert: {
          access_id?: string | null;
          adult_password?: string | null;
          adult_totp_enabled?: boolean;
          adult_totp_secret?: string | null;
          auth_user_id?: string | null;
          category_overrides?: Json;
          created_at?: string;
          email?: string | null;
          hidden_categories?: string[];
          id?: string;
          is_blocked?: boolean;
          last_access?: string | null;
          media_overrides?: Json;
          name?: string;
          password?: string | null;
          playlist_url?: string;
          role?: 'admin' | 'user';
          updated_at?: string;
          username?: string | null;
        };
        Update: {
          access_id?: string | null;
          adult_password?: string | null;
          adult_totp_enabled?: boolean;
          adult_totp_secret?: string | null;
          auth_user_id?: string | null;
          category_overrides?: Json;
          created_at?: string;
          email?: string | null;
          hidden_categories?: string[];
          id?: string;
          is_blocked?: boolean;
          last_access?: string | null;
          media_overrides?: Json;
          name?: string;
          password?: string | null;
          playlist_url?: string;
          role?: 'admin' | 'user';
          updated_at?: string;
          username?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      adult_access_set_password: {
        Args: {
          p_current_password?: string | null;
          p_new_password: string;
        };
        Returns: {
          enabled: boolean;
          totp_enabled: boolean;
        }[];
      };
      adult_access_unlock: {
        Args: {
          p_password: string;
        };
        Returns: {
          enabled: boolean;
          totp_enabled: boolean;
        }[];
      };
      authenticate_access_id: {
        Args: {
          p_identifier: string;
          p_password: string;
        };
        Returns: {
          access_id: string;
          has_auth_user: boolean;
          is_blocked: boolean;
          login_email: string;
          name: string;
          role: 'admin' | 'user';
          user_id: string;
          username: string | null;
        }[];
      };
      admin_hash_legacy_password: {
        Args: {
          p_password: string;
        };
        Returns: string;
      };
      sync_auth_users_to_xandeflix_users: {
        Args: Record<string, never>;
        Returns: {
          linked_count: number;
          inserted_count: number;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type XandeflixUserRow = Database['public']['Tables']['xandeflix_users']['Row'];
export type XandeflixUserInsert = Database['public']['Tables']['xandeflix_users']['Insert'];
export type XandeflixUserUpdate = Database['public']['Tables']['xandeflix_users']['Update'];
export type UserPreferencesRow = Database['public']['Tables']['user_preferences']['Row'];
export type UserPreferencesInsert = Database['public']['Tables']['user_preferences']['Insert'];
export type PlaylistCatalogSnapshotRow =
  Database['public']['Tables']['playlist_catalog_snapshots']['Row'];
export type GlobalMediaOverrideRow =
  Database['public']['Tables']['global_media_overrides']['Row'];
export type PlayerTelemetryReportRow =
  Database['public']['Tables']['player_telemetry_reports']['Row'];
export type AccessIdAuthRow =
  Database['public']['Functions']['authenticate_access_id']['Returns'][number];

export interface LegacyUserRecord {
  id: string;
  name: string;
  username: string;
  password?: string;
  playlistUrl?: string;
  isBlocked?: boolean;
  role?: 'admin' | 'user' | string;
  lastAccess?: string;
  hiddenCategories?: string[];
  categoryOverrides?: Record<string, string>;
  mediaOverrides?: Record<string, Json>;
  adultPassword?: string;
  adultTotpSecret?: string;
  adultTotpEnabled?: boolean;
}
