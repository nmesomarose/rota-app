import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';
import { api, ApiError } from '../services/api.ts';
import { typography, spacing, radii, shadows, type ColorTokens } from '../theme/tokens.ts';
import { useTheme } from '../theme/ThemeContext.tsx';

type Props = NativeStackScreenProps<RootStackParamList, 'ResetPassword'>;

/**
 * Accessible vector eye icon component using pure React Native shapes.
 */
function EyeIcon({ visible, color = '#64748B' }: { visible: boolean; color?: string }) {
  return (
    <View style={eyeStyles.container}>
      <View style={[eyeStyles.eyeOutline, { borderColor: color }]}>
        <View style={[eyeStyles.pupil, { backgroundColor: color }]} />
      </View>
      {!visible && <View style={[eyeStyles.slash, { backgroundColor: color }]} />}
    </View>
  );
}

const eyeStyles = StyleSheet.create({
  container: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyeOutline: {
    width: 22,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pupil: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  slash: {
    position: 'absolute',
    width: 22,
    height: 2,
    borderRadius: 1,
    transform: [{ rotate: '-45deg' }],
  },
});

export function ResetPasswordScreen({ navigation, route }: Props) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);

  const initialToken = route.params?.token || '';
  const [token, setToken] = useState(initialToken);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Synchronize token if passed or updated dynamically via deep link handoff
  useEffect(() => {
    if (route.params?.token && route.params.token !== token) {
      setToken(route.params.token);
    }
  }, [route.params?.token]);

  const passwordInputRef = useRef<TextInput>(null);
  const confirmPasswordInputRef = useRef<TextInput>(null);

  // Compulsory Password Criteria (Matches LoginScreen requirements)
  const hasMinLength = password.length >= 8;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  const allPasswordCriteriaMet = hasMinLength && hasLetter && hasNumber && hasSpecial;
  const passwordsMatch = password.length > 0 && password === confirmPassword;

  const handleResetPassword = async () => {
    setErrorMessage(null);

    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setErrorMessage('Please enter your reset token or link.');
      return;
    }

    if (!password) {
      setErrorMessage('Please enter a new password.');
      passwordInputRef.current?.focus();
      return;
    }

    if (!hasMinLength) {
      setErrorMessage('Password must be at least 8 characters long.');
      passwordInputRef.current?.focus();
      return;
    }

    if (!allPasswordCriteriaMet) {
      setErrorMessage('Password must satisfy all compulsory criteria (at least 8 characters, one letter, one number, and one special character).');
      passwordInputRef.current?.focus();
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match. Please ensure both fields are identical.');
      confirmPasswordInputRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      await api.auth.resetPassword(trimmedToken, password);
      setSuccess(true);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === 'INVALID_TOKEN') {
          setErrorMessage('Password reset token is invalid or does not exist. Please double-check the token or request a new reset link.');
        } else if (err.code === 'TOKEN_ALREADY_USED') {
          setErrorMessage('This password reset token has already been used. Please request a new reset link.');
        } else if (err.code === 'TOKEN_EXPIRED') {
          setErrorMessage('This password reset token has expired. Tokens are valid for 1 hour. Please request a new reset link.');
        } else if (err.statusCode === 429) {
          setErrorMessage('Too many attempts. Please wait a few minutes before trying again.');
        } else if (err.code === 'VALIDATION_ERROR') {
          setErrorMessage(err.message || 'Validation failed. Password must be at least 8 characters.');
        } else {
          setErrorMessage(err.message || 'Failed to reset password. Please try again.');
        }
      } else {
        const msg = err instanceof Error ? err.message : 'Network error. Please check your connection.';
        setErrorMessage(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  // Success Confirmation View
  if (success) {
    return (
      <View style={styles.successContainer}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={styles.successCard}>
          <View style={styles.successIconBadge}>
            <Text style={styles.successIconText}>✓</Text>
          </View>
          <Text style={styles.successHeader}>Password Reset Complete</Text>
          <Text style={styles.successDescription}>
            Your password has been reset successfully. For your protection, all active sessions on other devices have been signed out.
          </Text>
          <TouchableOpacity
            style={styles.signInButton}
            onPress={() =>
              navigation.reset({
                index: 0,
                routes: [{ name: 'Auth' }],
              })
            }
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Sign in with your new password"
          >
            <Text style={styles.signInButtonText}>Sign In With New Password</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.keyboardContainer}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 10 : 0}
    >
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ScrollView
        contentContainerStyle={[
          styles.scrollContainer,
          {
            paddingTop: Math.max(insets.top, 24) + 12,
            paddingBottom: Math.max(insets.bottom, 24) + 12,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Navigation Bar Back to Sign In */}
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.navigate('Auth')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back to sign in"
        >
          <Text style={styles.backButtonText}>← Back to Sign In</Text>
        </TouchableOpacity>

        {/* Brand Header */}
        <View style={styles.header}>
          <Image
            source={require('../../assets/icon.png')}
            style={styles.logoImage}
            resizeMode="contain"
          />
          <Text style={styles.appTitle}>Set New Password</Text>
          <Text style={styles.appSubtitle}>
            Enter the reset token received in your email and choose your new password.
          </Text>
        </View>

        {/* Form Card */}
        <View style={styles.card}>
          {/* Error Banner */}
          {errorMessage && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          )}

          {/* Reset Token Input */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Reset Token</Text>
            <TextInput
              style={styles.input}
              placeholder="Paste 64-character token from email"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              onSubmitEditing={() => passwordInputRef.current?.focus()}
              value={token}
              onChangeText={setToken}
              editable={!loading}
              accessibilityLabel="Reset token input"
            />
            <Text style={styles.helperText}>
              Paste the secret token provided in your reset email.
            </Text>
          </View>

          {/* New Password Input */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>New Password</Text>
            <View
              style={[
                styles.passwordContainer,
                allPasswordCriteriaMet && styles.passwordContainerValid,
              ]}
            >
              <TextInput
                ref={passwordInputRef}
                style={styles.passwordInput}
                placeholder="Enter your new password"
                placeholderTextColor={colors.textMuted}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="next"
                onSubmitEditing={() => confirmPasswordInputRef.current?.focus()}
                value={password}
                onChangeText={setPassword}
                editable={!loading}
                accessibilityLabel="New password input"
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setShowPassword((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                activeOpacity={0.7}
              >
                <EyeIcon visible={showPassword} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Compulsory Password Checklist */}
            <View style={styles.checklistContainer}>
              <Text style={styles.checklistTitle}>Compulsory Password Requirements:</Text>

              <View style={[styles.checklistItem, hasMinLength && styles.checklistItemValid]}>
                <View style={[styles.checklistIconBadge, hasMinLength && styles.checklistIconBadgeValid]}>
                  <Text style={[styles.checklistIconText, hasMinLength && styles.checklistIconTextValid]}>
                    {hasMinLength ? '✓' : '○'}
                  </Text>
                </View>
                <Text style={[styles.checklistLabel, hasMinLength && styles.checklistLabelValid]}>
                  At least 8 characters {password.length > 0 && `(${password.length}/8)`}
                </Text>
              </View>

              <View style={[styles.checklistItem, hasLetter && styles.checklistItemValid]}>
                <View style={[styles.checklistIconBadge, hasLetter && styles.checklistIconBadgeValid]}>
                  <Text style={[styles.checklistIconText, hasLetter && styles.checklistIconTextValid]}>
                    {hasLetter ? '✓' : '○'}
                  </Text>
                </View>
                <Text style={[styles.checklistLabel, hasLetter && styles.checklistLabelValid]}>
                  At least one normal letter (a-z, A-Z)
                </Text>
              </View>

              <View style={[styles.checklistItem, hasNumber && styles.checklistItemValid]}>
                <View style={[styles.checklistIconBadge, hasNumber && styles.checklistIconBadgeValid]}>
                  <Text style={[styles.checklistIconText, hasNumber && styles.checklistIconTextValid]}>
                    {hasNumber ? '✓' : '○'}
                  </Text>
                </View>
                <Text style={[styles.checklistLabel, hasNumber && styles.checklistLabelValid]}>
                  At least one number (0-9)
                </Text>
              </View>

              <View style={[styles.checklistItem, hasSpecial && styles.checklistItemValid]}>
                <View style={[styles.checklistIconBadge, hasSpecial && styles.checklistIconBadgeValid]}>
                  <Text style={[styles.checklistIconText, hasSpecial && styles.checklistIconTextValid]}>
                    {hasSpecial ? '✓' : '○'}
                  </Text>
                </View>
                <Text style={[styles.checklistLabel, hasSpecial && styles.checklistLabelValid]}>
                  At least one special character (!@#$%^&*...)
                </Text>
              </View>
            </View>
          </View>

          {/* Confirm Password Input */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Confirm New Password</Text>
            <View
              style={[
                styles.passwordContainer,
                passwordsMatch && styles.passwordContainerValid,
              ]}
            >
              <TextInput
                ref={confirmPasswordInputRef}
                style={styles.passwordInput}
                placeholder="Re-enter your new password"
                placeholderTextColor={colors.textMuted}
                secureTextEntry={!showConfirmPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="done"
                onSubmitEditing={handleResetPassword}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                editable={!loading}
                accessibilityLabel="Confirm new password input"
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setShowConfirmPassword((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={showConfirmPassword ? 'Hide password' : 'Show password'}
                activeOpacity={0.7}
              >
                <EyeIcon visible={showConfirmPassword} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {confirmPassword.length > 0 && !passwordsMatch && (
              <Text style={styles.mismatchText}>Passwords do not match.</Text>
            )}
          </View>

          {/* Submit Button */}
          <TouchableOpacity
            style={[
              styles.button,
              (!allPasswordCriteriaMet || !passwordsMatch || !token.trim() || loading) && styles.buttonDisabled,
            ]}
            onPress={handleResetPassword}
            disabled={!allPasswordCriteriaMet || !passwordsMatch || !token.trim() || loading}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Reset Password"
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.buttonText}>Reset Password</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <TouchableOpacity
            onPress={() => navigation.navigate('ForgotPassword')}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.footerLinkText}>
              Need a new token? <Text style={styles.footerLinkHighlight}>Request another link</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ColorTokens, isDark: boolean) {
  return StyleSheet.create({
  keyboardContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContainer: {
    flexGrow: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingBottom: spacing.xxxl,
    justifyContent: 'center',
  },
  backButton: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.subtle,
  },
  backButtonText: {
    fontSize: typography.sizes.sm,
    fontWeight: typography.weights.semiBold,
    color: colors.primaryNavy,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },
  logoImage: {
    width: 68,
    height: 68,
    borderRadius: radii.lg,
    marginBottom: spacing.md,
  },
  appTitle: {
    fontSize: typography.sizes.xxl,
    fontWeight: typography.weights.bold,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  appSubtitle: {
    fontSize: typography.sizes.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  errorBanner: {
    backgroundColor: colors.errorLight,
    borderColor: colors.errorBorder,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  errorText: {
    color: colors.errorText,
    fontSize: typography.sizes.sm,
    lineHeight: 18,
    fontWeight: typography.weights.medium,
  },
  inputGroup: {
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: typography.sizes.sm,
    fontWeight: typography.weights.semiBold,
    color: colors.textPrimary,
    marginBottom: spacing.xs + 2,
  },
  input: {
    backgroundColor: colors.surfaceSubtle,
    borderColor: colors.border,
    borderWidth: 1.5,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm + 2,
    fontSize: typography.sizes.md,
    color: colors.textPrimary,
  },
  helperText: {
    fontSize: typography.sizes.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
    borderColor: colors.border,
    borderWidth: 1.5,
    borderRadius: radii.md,
  },
  passwordContainerValid: {
    borderColor: colors.success,
    backgroundColor: isDark ? '#064E3B33' : '#F0FDF4',
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm + 2,
    fontSize: typography.sizes.md,
    color: colors.textPrimary,
  },
  eyeButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  checklistContainer: {
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  checklistTitle: {
    fontSize: typography.sizes.xs + 1,
    fontWeight: typography.weights.bold,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  checklistItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  checklistItemValid: {
    opacity: 1,
  },
  checklistIconBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  checklistIconBadgeValid: {
    borderColor: colors.success,
    backgroundColor: colors.success,
  },
  checklistIconText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    lineHeight: 12,
  },
  checklistIconTextValid: {
    color: colors.white,
  },
  checklistLabel: {
    fontSize: typography.sizes.xs + 1,
    color: colors.textSecondary,
  },
  checklistLabelValid: {
    color: isDark ? '#34D399' : '#065F46',
    fontWeight: typography.weights.semiBold,
  },
  mismatchText: {
    fontSize: typography.sizes.xs,
    color: colors.errorText,
    marginTop: spacing.xs,
  },
  button: {
    backgroundColor: colors.primaryTeal,
    borderRadius: radii.md,
    paddingVertical: spacing.lg - 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    ...shadows.subtle,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: colors.white,
    fontSize: typography.sizes.md,
    fontWeight: typography.weights.bold,
  },
  footer: {
    marginTop: spacing.xl,
    alignItems: 'center',
  },
  footerLinkText: {
    fontSize: typography.sizes.sm,
    color: colors.textSecondary,
  },
  footerLinkHighlight: {
    color: colors.primaryTeal,
    fontWeight: typography.weights.semiBold,
  },
  successContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  successCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: spacing.xxxl,
    alignItems: 'center',
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.elevated,
  },
  successIconBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  successIconText: {
    color: colors.white,
    fontSize: 32,
    fontWeight: '800',
  },
  successHeader: {
    fontSize: typography.sizes.xl,
    fontWeight: typography.weights.bold,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  successDescription: {
    fontSize: typography.sizes.sm + 1,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xxl,
  },
  signInButton: {
    backgroundColor: colors.primaryTeal,
    borderRadius: radii.md,
    paddingVertical: spacing.lg - 2,
    paddingHorizontal: spacing.xxl,
    width: '100%',
    alignItems: 'center',
    ...shadows.subtle,
  },
  signInButtonText: {
    color: colors.white,
    fontSize: typography.sizes.md,
    fontWeight: typography.weights.bold,
  },
  });
}
