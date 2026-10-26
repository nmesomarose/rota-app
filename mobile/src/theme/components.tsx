import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
  type TextInputProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { typography, spacing, radii } from './tokens.ts';
import { useTheme } from './ThemeContext.tsx';

// ----------------------------------------------------
// 1. Button Component
// ----------------------------------------------------
export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'navy' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  iconPosition?: 'left' | 'right';
  style?: ViewStyle;
  textStyle?: TextStyle;
  accessibilityLabel?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  iconPosition = 'left',
  style,
  textStyle,
  accessibilityLabel,
}: ButtonProps) {
  const { colors } = useTheme();

  const getVariantStyles = (): { container: ViewStyle; text: TextStyle; spinnerColor: string } => {
    switch (variant) {
      case 'navy':
        return {
          container: {
            backgroundColor: colors.primaryNavy,
            borderColor: colors.primaryNavy,
          },
          text: { color: colors.white },
          spinnerColor: colors.white,
        };
      case 'secondary':
        return {
          container: {
            backgroundColor: colors.lightTeal,
            borderColor: colors.lightTeal,
          },
          text: { color: colors.tealDark },
          spinnerColor: colors.primaryTeal,
        };
      case 'outline':
        return {
          container: {
            backgroundColor: 'transparent',
            borderColor: colors.border,
            borderWidth: 1.2,
          },
          text: { color: colors.textPrimary },
          spinnerColor: colors.textPrimary,
        };
      case 'ghost':
        return {
          container: {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
          },
          text: { color: colors.primaryTeal },
          spinnerColor: colors.primaryTeal,
        };
      case 'danger':
        return {
          container: {
            backgroundColor: colors.error,
            borderColor: colors.error,
          },
          text: { color: '#FFFFFF' },
          spinnerColor: '#FFFFFF',
        };
      case 'primary':
      default:
        return {
          container: {
            backgroundColor: colors.primaryTeal,
            borderColor: colors.primaryTeal,
          },
          text: { color: '#FFFFFF' },
          spinnerColor: '#FFFFFF',
        };
    }
  };

  const getSizeStyles = (): { container: ViewStyle; text: TextStyle; iconSize: number } => {
    switch (size) {
      case 'sm':
        return {
          container: {
            paddingVertical: spacing.xs + 2,
            paddingHorizontal: spacing.md,
            minHeight: 36,
          },
          text: { fontSize: typography.sizes.sm },
          iconSize: 16,
        };
      case 'lg':
        return {
          container: {
            paddingVertical: spacing.md + 2,
            paddingHorizontal: spacing.xxl,
            minHeight: 52,
          },
          text: { fontSize: typography.sizes.lg },
          iconSize: 22,
        };
      case 'md':
      default:
        return {
          container: {
            paddingVertical: spacing.sm + 4,
            paddingHorizontal: spacing.lg,
            minHeight: 46, // Minimum touch target compliance
          },
          text: { fontSize: typography.sizes.md },
          iconSize: 18,
        };
    }
  };

  const vStyles = getVariantStyles();
  const sStyles = getSizeStyles();

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      style={[
        buttonStyles.base,
        vStyles.container,
        sStyles.container,
        disabled && buttonStyles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={vStyles.spinnerColor} />
      ) : (
        <View style={buttonStyles.contentRow}>
          {icon && iconPosition === 'left' && (
            <Ionicons
              name={icon}
              size={sStyles.iconSize}
              color={vStyles.text.color as string}
              style={{ marginRight: spacing.xs + 2 }}
            />
          )}
          <Text style={[buttonStyles.text, vStyles.text, sStyles.text, textStyle]}>
            {title}
          </Text>
          {icon && iconPosition === 'right' && (
            <Ionicons
              name={icon}
              size={sStyles.iconSize}
              color={vStyles.text.color as string}
              style={{ marginLeft: spacing.xs + 2 }}
            />
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

const buttonStyles = StyleSheet.create({
  base: {
    borderRadius: radii.md,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    borderWidth: 1,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontWeight: typography.weights.semiBold,
    textAlign: 'center',
    flexShrink: 1,
  },
  disabled: {
    opacity: 0.5,
  },
});

// ----------------------------------------------------
// 2. Card Component
// ----------------------------------------------------
export interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
  variant?: 'default' | 'subtle' | 'elevated' | 'selected';
}

export function Card({ children, style, onPress, variant = 'default' }: CardProps) {
  const { colors, shadows } = useTheme();

  const getVariantStyle = (): ViewStyle => {
    switch (variant) {
      case 'subtle':
        return {
          backgroundColor: colors.surfaceSubtle,
          borderColor: colors.borderSubtle,
        };
      case 'elevated':
        return {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          ...shadows.elevated,
        };
      case 'selected':
        return {
          backgroundColor: colors.lightTeal,
          borderColor: colors.primaryTeal,
          borderWidth: 1.5,
        };
      case 'default':
      default:
        return {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          ...shadows.card,
        };
    }
  };

  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        style={[cardStyles.base, getVariantStyle(), style]}
      >
        {children}
      </TouchableOpacity>
    );
  }

  return <View style={[cardStyles.base, getVariantStyle(), style]}>{children}</View>;
}

const cardStyles = StyleSheet.create({
  base: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
});

// ----------------------------------------------------
// 3. Badge Component
// ----------------------------------------------------
export interface BadgeProps {
  label: string;
  variant?: 'teal' | 'navy' | 'success' | 'warning' | 'error' | 'neutral';
  size?: 'sm' | 'md';
  style?: ViewStyle;
  textStyle?: TextStyle;
  icon?: keyof typeof Ionicons.glyphMap;
}

export function Badge({
  label,
  variant = 'teal',
  size = 'md',
  style,
  textStyle,
  icon,
}: BadgeProps) {
  const { colors } = useTheme();

  const getBadgeStyle = (): { container: ViewStyle; text: TextStyle } => {
    switch (variant) {
      case 'navy':
        return {
          container: {
            backgroundColor: colors.surfaceSubtle,
            borderColor: colors.border,
          },
          text: { color: colors.primaryNavy },
        };
      case 'success':
        return {
          container: {
            backgroundColor: colors.successLight,
            borderColor: colors.successBorder,
          },
          text: { color: colors.successText },
        };
      case 'warning':
        return {
          container: {
            backgroundColor: colors.warningLight,
            borderColor: colors.warningBorder,
          },
          text: { color: colors.warningText },
        };
      case 'error':
        return {
          container: {
            backgroundColor: colors.errorLight,
            borderColor: colors.errorBorder,
          },
          text: { color: colors.errorText },
        };
      case 'neutral':
        return {
          container: {
            backgroundColor: colors.surfaceSelected,
            borderColor: colors.border,
          },
          text: { color: colors.textSecondary },
        };
      case 'teal':
      default:
        return {
          container: {
            backgroundColor: colors.lightTeal,
            borderColor: colors.borderFocus,
          },
          text: { color: colors.tealDark },
        };
    }
  };

  const isSmall = size === 'sm';
  const bStyle = getBadgeStyle();

  return (
    <View
      style={[
        badgeStyles.base,
        isSmall ? badgeStyles.sm : badgeStyles.md,
        bStyle.container,
        style,
      ]}
    >
      {icon && (
        <Ionicons
          name={icon}
          size={isSmall ? 10 : 12}
          color={bStyle.text.color as string}
          style={{ marginRight: 3 }}
        />
      )}
      <Text
        style={[
          badgeStyles.text,
          isSmall ? badgeStyles.textSm : badgeStyles.textMd,
          bStyle.text,
          textStyle,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  sm: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
  },
  md: {
    paddingVertical: 3,
    paddingHorizontal: spacing.md,
  },
  text: {
    fontWeight: typography.weights.bold,
  },
  textSm: {
    fontSize: typography.sizes.xs,
  },
  textMd: {
    fontSize: typography.sizes.sm,
  },
});

// ----------------------------------------------------
// 4. InputField Component
// ----------------------------------------------------
export interface InputFieldProps extends TextInputProps {
  label?: string;
  error?: string | null;
  hint?: string;
  containerStyle?: ViewStyle;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightIconPress?: () => void;
}

export function InputField({
  label,
  error,
  hint,
  containerStyle,
  leftIcon,
  rightIcon,
  onRightIconPress,
  style,
  ...inputProps
}: InputFieldProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = React.useState(false);

  return (
    <View style={[inputStyles.container, containerStyle]}>
      {label && <Text style={[inputStyles.label, { color: colors.textPrimary }]}>{label}</Text>}
      <View
        style={[
          inputStyles.inputWrapper,
          {
            backgroundColor: colors.surface,
            borderColor: Boolean(error) ? colors.error : focused ? colors.primaryTeal : colors.border,
          },
        ]}
      >
        {leftIcon && (
          <Ionicons
            name={leftIcon}
            size={20}
            color={colors.textSecondary}
            style={inputStyles.leftIcon}
          />
        )}
        <TextInput
          placeholderTextColor={colors.textMuted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[inputStyles.input, { color: colors.textPrimary }, style]}
          {...inputProps}
        />
        {rightIcon && (
          <TouchableOpacity
            onPress={onRightIconPress}
            disabled={!onRightIconPress}
            style={inputStyles.rightIcon}
          >
            <Ionicons name={rightIcon} size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>
      {error ? (
        <Text style={[inputStyles.errorText, { color: colors.error }]}>{error}</Text>
      ) : hint ? (
        <Text style={[inputStyles.hintText, { color: colors.textSecondary }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const inputStyles = StyleSheet.create({
  container: {
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: typography.sizes.sm,
    fontWeight: typography.weights.semiBold,
    marginBottom: spacing.xs + 2,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.2,
    borderRadius: radii.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  leftIcon: {
    marginRight: spacing.sm,
  },
  rightIcon: {
    padding: spacing.xs,
    marginLeft: spacing.sm,
  },
  input: {
    flex: 1,
    fontSize: typography.sizes.md,
    paddingVertical: spacing.sm,
  },
  errorText: {
    fontSize: typography.sizes.xs,
    marginTop: spacing.xs,
    fontWeight: typography.weights.medium,
  },
  hintText: {
    fontSize: typography.sizes.xs,
    marginTop: spacing.xs,
  },
});

// ----------------------------------------------------
// 5. OfflineBanner Component
// ----------------------------------------------------
export interface OfflineBannerProps {
  visible: boolean;
  isChecking?: boolean;
  onRetry: () => void;
  message?: string;
  style?: ViewStyle;
}

export function OfflineBanner({
  visible,
  isChecking = false,
  onRetry,
  message = 'Working offline. Shift schedule and activity feed remain cached.',
  style,
}: OfflineBannerProps) {
  const { colors } = useTheme();

  if (!visible) return null;

  return (
    <View style={[bannerStyles.container, { backgroundColor: colors.warningLight, borderBottomColor: colors.warningBorder }, style]}>
      <View style={bannerStyles.content}>
        <Ionicons name="cloud-offline-outline" size={20} color={colors.warningText} style={bannerStyles.icon} />
        <Text style={[bannerStyles.text, { color: colors.warningText }]}>{message}</Text>
      </View>
      <TouchableOpacity
        onPress={onRetry}
        disabled={isChecking}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Retry connection"
        style={[bannerStyles.retryButton, { backgroundColor: colors.warningBorder }]}
      >
        {isChecking ? (
          <ActivityIndicator size="small" color={colors.warningText} />
        ) : (
          <Text style={[bannerStyles.retryText, { color: colors.warningText }]}>Retry</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  container: {
    borderBottomWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: spacing.md,
  },
  icon: {
    marginRight: spacing.sm,
  },
  text: {
    fontSize: typography.sizes.xs,
    fontWeight: typography.weights.medium,
    flex: 1,
  },
  retryButton: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
  },
  retryText: {
    fontSize: typography.sizes.xs,
    fontWeight: typography.weights.bold,
  },
});

// ----------------------------------------------------
// 6. EmptyState Component
// ----------------------------------------------------
export interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  actionTitle?: string;
  onAction?: () => void;
  style?: ViewStyle;
}

export function EmptyState({
  icon = 'file-tray-outline',
  title,
  description,
  actionTitle,
  onAction,
  style,
}: EmptyStateProps) {
  const { colors } = useTheme();

  return (
    <View style={[emptyStyles.container, style]}>
      <View style={[emptyStyles.iconCircle, { backgroundColor: colors.surfaceSelected }]}>
        <Ionicons name={icon} size={36} color={colors.textSecondary} />
      </View>
      <Text style={[emptyStyles.title, { color: colors.textPrimary }]}>{title}</Text>
      <Text style={[emptyStyles.description, { color: colors.textSecondary }]}>{description}</Text>
      {actionTitle && onAction && (
        <Button
          title={actionTitle}
          onPress={onAction}
          variant="secondary"
          size="sm"
          style={emptyStyles.action}
        />
      )}
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    marginVertical: spacing.xl,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: {
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  description: {
    fontSize: typography.sizes.sm,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: '100%',
    paddingHorizontal: spacing.sm,
  },
  action: {
    marginTop: spacing.lg,
  },
});
