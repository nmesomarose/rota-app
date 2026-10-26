import { controlPool } from '../db/connection.ts';
import { AppError } from '../utils/errors.ts';

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export interface NotificationCategories {
  shifts: boolean;
  swaps: boolean;
  approvals: boolean;
  attendance: boolean;
  billing: boolean;
  security: boolean;
}

export interface UserSettings {
  timeZone: string;
  quietHours: QuietHours;
  language: string;
  theme: 'system' | 'light' | 'dark';
  notificationCategories: NotificationCategories;
}

export interface FieldTimestamps {
  timeZone: string;
  quietHours: string;
  language: string;
  theme: string;
  notificationCategories: string;
}

export interface UserSettingsResponse {
  settings: UserSettings;
  fieldTimestamps: FieldTimestamps;
  updatedAt: string;
}

export interface UpdateSettingsInput {
  timeZone?: string;
  quietHours?: QuietHours;
  language?: string;
  theme?: 'system' | 'light' | 'dark';
  notificationCategories?: Partial<NotificationCategories>;
  clientTimestamps?: Record<string, string>;
  clientTimestamp?: string;
}

export const DEFAULT_NOTIFICATION_CATEGORIES: NotificationCategories = {
  shifts: true,
  swaps: true,
  approvals: true,
  attendance: true,
  billing: true,
  security: true,
};

export const DEFAULT_SETTINGS: UserSettings = {
  timeZone: 'UTC',
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '07:00',
  },
  language: 'en',
  theme: 'system',
  notificationCategories: DEFAULT_NOTIFICATION_CATEGORIES,
};

interface UserSettingsDbRow {
  user_id: string;
  time_zone: string;
  time_zone_updated_at: Date;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_updated_at: Date;
  language: string;
  language_updated_at: Date;
  theme: 'system' | 'light' | 'dark';
  theme_updated_at: Date;
  notification_categories: NotificationCategories;
  notification_categories_updated_at: Date;
  created_at: Date;
  updated_at: Date;
}

function mapRowToResponse(row: UserSettingsDbRow): UserSettingsResponse {
  return {
    settings: {
      timeZone: row.time_zone,
      quietHours: {
        enabled: row.quiet_hours_enabled,
        start: row.quiet_hours_start,
        end: row.quiet_hours_end,
      },
      language: row.language,
      theme: row.theme,
      notificationCategories: {
        ...DEFAULT_NOTIFICATION_CATEGORIES,
        ...(row.notification_categories || {}),
      },
    },
    fieldTimestamps: {
      timeZone: new Date(row.time_zone_updated_at).toISOString(),
      quietHours: new Date(row.quiet_hours_updated_at).toISOString(),
      language: new Date(row.language_updated_at).toISOString(),
      theme: new Date(row.theme_updated_at).toISOString(),
      notificationCategories: new Date(row.notification_categories_updated_at).toISOString(),
    },
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Retrieves the settings for a user. If no settings exist yet, provisions the defaults.
 */
export async function getUserSettings(userId: string): Promise<UserSettingsResponse> {
  const existingRes = await controlPool.query<UserSettingsDbRow>(
    `SELECT * FROM user_settings WHERE user_id = $1`,
    [userId]
  );

  if (existingRes.rowCount && existingRes.rowCount > 0) {
    return mapRowToResponse(existingRes.rows[0]);
  }

  // Provision defaults on first read (idempotent ON CONFLICT)
  const insertRes = await controlPool.query<UserSettingsDbRow>(
    `INSERT INTO user_settings (
      user_id,
      time_zone,
      time_zone_updated_at,
      quiet_hours_enabled,
      quiet_hours_start,
      quiet_hours_end,
      quiet_hours_updated_at,
      language,
      language_updated_at,
      theme,
      theme_updated_at,
      notification_categories,
      notification_categories_updated_at,
      created_at,
      updated_at
    ) VALUES (
      $1,
      $2, NOW(),
      $3, $4, $5, NOW(),
      $6, NOW(),
      $7, NOW(),
      $8::jsonb, NOW(),
      NOW(), NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET updated_at = user_settings.updated_at
    RETURNING *`,
    [
      userId,
      DEFAULT_SETTINGS.timeZone,
      DEFAULT_SETTINGS.quietHours.enabled,
      DEFAULT_SETTINGS.quietHours.start,
      DEFAULT_SETTINGS.quietHours.end,
      DEFAULT_SETTINGS.language,
      DEFAULT_SETTINGS.theme,
      JSON.stringify(DEFAULT_SETTINGS.notificationCategories),
    ]
  );

  return mapRowToResponse(insertRes.rows[0]);
}

/**
 * Updates user settings with per-field conflict resolution (FR-SET-005, AC-SET-01).
 *
 * Conflict Resolution Invariants:
 * 1. Independent fields updated across different devices both survive.
 * 2. If an incoming update for a specific field has a client timestamp older than the server's
 *    field timestamp, the older replayed edit is dropped in favor of the newer server value.
 * 3. An update without a client timestamp is treated as a live edit (NOW()) and succeeds.
 */
export async function updateUserSettings(
  userId: string,
  input: UpdateSettingsInput
): Promise<UserSettingsResponse> {
  // Ensure the settings row exists first
  await getUserSettings(userId);

  // Fetch current row inside an explicit read to compare timestamps
  const currentRes = await controlPool.query<UserSettingsDbRow>(
    `SELECT * FROM user_settings WHERE user_id = $1 FOR UPDATE`,
    [userId]
  );

  if (!currentRes.rowCount || currentRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'User settings record not found');
  }

  const current = currentRes.rows[0];

  const updateFields: string[] = [];
  const updateValues: unknown[] = [];
  let paramIndex = 1;

  function shouldUpdateField(
    fieldName: keyof FieldTimestamps,
    serverDate: Date
  ): boolean {
    const rawClientTs =
      input.clientTimestamps?.[fieldName] || input.clientTimestamp;
    if (!rawClientTs) {
      return true; // No timestamp supplied; treat as current authoritative edit
    }

    const clientMs = new Date(rawClientTs).getTime();
    if (isNaN(clientMs)) {
      return true;
    }

    const serverMs = new Date(serverDate).getTime();
    // Older replayed edit loses (AC-SET-01, FR-SET-005)
    return clientMs >= serverMs;
  }

  // 1. timeZone
  if (input.timeZone !== undefined) {
    if (shouldUpdateField('timeZone', current.time_zone_updated_at)) {
      updateFields.push(`time_zone = $${paramIndex++}`);
      updateValues.push(input.timeZone);
      updateFields.push(`time_zone_updated_at = NOW()`);
    }
  }

  // 2. quietHours
  if (input.quietHours !== undefined) {
    if (shouldUpdateField('quietHours', current.quiet_hours_updated_at)) {
      updateFields.push(`quiet_hours_enabled = $${paramIndex++}`);
      updateValues.push(input.quietHours.enabled);
      updateFields.push(`quiet_hours_start = $${paramIndex++}`);
      updateValues.push(input.quietHours.start);
      updateFields.push(`quiet_hours_end = $${paramIndex++}`);
      updateValues.push(input.quietHours.end);
      updateFields.push(`quiet_hours_updated_at = NOW()`);
    }
  }

  // 3. language
  if (input.language !== undefined) {
    if (shouldUpdateField('language', current.language_updated_at)) {
      updateFields.push(`language = $${paramIndex++}`);
      updateValues.push(input.language);
      updateFields.push(`language_updated_at = NOW()`);
    }
  }

  // 4. theme
  if (input.theme !== undefined) {
    if (shouldUpdateField('theme', current.theme_updated_at)) {
      updateFields.push(`theme = $${paramIndex++}`);
      updateValues.push(input.theme);
      updateFields.push(`theme_updated_at = NOW()`);
    }
  }

  // 5. notificationCategories
  if (input.notificationCategories !== undefined) {
    if (
      shouldUpdateField(
        'notificationCategories',
        current.notification_categories_updated_at
      )
    ) {
      const merged = {
        ...DEFAULT_NOTIFICATION_CATEGORIES,
        ...(current.notification_categories || {}),
        ...input.notificationCategories,
      };
      updateFields.push(`notification_categories = $${paramIndex++}::jsonb`);
      updateValues.push(JSON.stringify(merged));
      updateFields.push(`notification_categories_updated_at = NOW()`);
    }
  }

  // If no fields need updating (e.g. all incoming fields were older replayed edits)
  if (updateFields.length === 0) {
    return mapRowToResponse(current);
  }

  updateFields.push(`updated_at = NOW()`);
  updateValues.push(userId);

  const sql = `
    UPDATE user_settings
    SET ${updateFields.join(', ')}
    WHERE user_id = $${paramIndex}
    RETURNING *
  `;

  const updatedRes = await controlPool.query<UserSettingsDbRow>(sql, updateValues);
  return mapRowToResponse(updatedRes.rows[0]);
}
