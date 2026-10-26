import React, { useState, useRef, useMemo } from 'react';
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
import { colors, typography, spacing, radii, shadows, useTheme, type ColorTokens } from '../theme/index.ts';

type Props = NativeStackScreenProps<RootStackParamList, 'ForgotPassword'>;

export function ForgotPasswordScreen({ navigation, route }: Props) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const initialEmail = route.params?.prefilledEmail || '';
  const [email, setEmail] = useState(initialEmail);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [devResetToken, setDevResetToken] = useState<string | undefined>(undefined);

  const emailInputRef = useRef<TextInput>(null);

  const validateEmail = (val: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());
  };

  const handleRequestReset = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setErrorMessage('Please enter your email address.');
      emailInputRef.current?.focus();
      return;
    }

    if (!validateEmail(trimmedEmail)) {
      setErrorMessage('Please enter a valid email address (e.g. user@example.com).');
      emailInputRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      const response = await api.auth.forgotPassword(trimmedEmail);
      // Preserve anti-enumeration response from server
      setSuccessMessage(
        response.message || 'If an account exists with this email, a password reset link has been sent.'
      );
      if (response.resetToken) {
        setDevResetToken(response.resetToken);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.statusCode === 429) {
          setErrorMessage('Too many password reset requests. Please wait a few minutes before trying again.');
        } else if (err.code === 'VALIDATION_ERROR') {
          setErrorMessage('Please enter a valid email address.');
        } else {
          setErrorMessage(err.message || 'Unable to process password reset request.');
        }
      } else {
        const msg = err instanceof Error ? err.message : 'Network error. Please check your connection.';
        setErrorMessage(msg);
      }
    } finally {
      setLoading(false);
    }
  };

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
          <Text style={styles.appTitle}>Reset Your Password</Text>
          <Text style={styles.appSubtitle}>
            Enter the email address registered with your Rota account to receive password reset instructions.
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

          {/* Success Banner */}
          {successMessage && (
            <View style={styles.successBanner}>
              <View style={styles.successIconBadge}>
                <Text style={styles.successIconText}>✓</Text>
              </View>
              <Text style={styles.successTitle}>Instructions Sent</Text>
              <Text style={styles.successText}>{successMessage}</Text>
              <Text style={styles.instructionsText}>
                Check your inbox and spam folder for the reset instructions. If you received your token, continue to the reset screen below.
              </Text>

              <TouchableOpacity
                style={styles.continueButton}
                onPress={() =>
                  navigation.navigate('ResetPassword', {
                    email: email.trim().toLowerCase(),
                    token: devResetToken,
                  })
                }
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Enter reset token and set new password"
              >
                <Text style={styles.continueButtonText}>Enter Reset Token & Set Password →</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Email Input Form (Visible before or after request) */}
          {!successMessage && (
            <>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Email Address</Text>
                <TextInput
                  ref={emailInputRef}
                  style={styles.input}
                  placeholder="user@example.com"
                  placeholderTextColor="#94A3B8"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  returnKeyType="done"
                  onSubmitEditing={handleRequestReset}
                  value={email}
                  onChangeText={setEmail}
                  editable={!loading}
                  accessibilityLabel="Email Address input for password reset"
                />
              </View>

              <TouchableOpacity
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handleRequestReset}
                disabled={loading}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Send password reset link"
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Send Reset Link</Text>
                )}
              </TouchableOpacity>
            </>
          )}

          {/* Direct Link to Enter Token if already received */}
          <TouchableOpacity
            style={styles.manualTokenLink}
            onPress={() =>
              navigation.navigate('ResetPassword', {
                email: email.trim().toLowerCase(),
                token: devResetToken,
              })
            }
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.manualTokenText}>
              Already have a reset token? <Text style={styles.manualTokenHighlight}>Enter it here →</Text>
            </Text>
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <TouchableOpacity
            onPress={() => navigation.navigate('Auth')}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.footerLinkText}>Return to Sign In</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: ColorTokens, isDark: boolean) =>
  StyleSheet.create({
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
    successBanner: {
      backgroundColor: colors.successLight,
      borderColor: colors.successBorder,
      borderWidth: 1,
      borderRadius: radii.lg,
      padding: spacing.lg,
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    successIconBadge: {
      width: 44,
      height: 44,
      borderRadius: radii.full,
      backgroundColor: colors.success,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.sm,
    },
    successIconText: {
      color: '#FFFFFF',
      fontSize: 22,
      fontWeight: '700',
    },
    successTitle: {
      fontSize: typography.sizes.lg,
      fontWeight: typography.weights.bold,
      color: colors.successText,
      marginBottom: spacing.xs,
    },
    successText: {
      fontSize: typography.sizes.sm,
      color: colors.successText,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: spacing.sm,
    },
    instructionsText: {
      fontSize: typography.sizes.xs + 1,
      color: colors.successText,
      textAlign: 'center',
      lineHeight: 18,
      marginBottom: spacing.lg,
    },
    continueButton: {
      backgroundColor: colors.primaryTeal,
      borderRadius: radii.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      width: '100%',
      alignItems: 'center',
      ...shadows.subtle,
    },
    continueButtonText: {
      color: '#FFFFFF',
      fontSize: typography.sizes.sm + 1,
      fontWeight: typography.weights.bold,
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
    button: {
      backgroundColor: colors.primaryNavy,
      borderRadius: radii.md,
      paddingVertical: spacing.lg - 2,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xs,
      ...shadows.subtle,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    buttonText: {
      color: '#FFFFFF',
      fontSize: typography.sizes.md,
      fontWeight: typography.weights.bold,
    },
    manualTokenLink: {
      marginTop: spacing.lg,
      paddingVertical: spacing.sm,
      alignItems: 'center',
    },
    manualTokenText: {
      fontSize: typography.sizes.sm,
      color: colors.textSecondary,
    },
    manualTokenHighlight: {
      color: colors.primaryTeal,
      fontWeight: typography.weights.semiBold,
    },
    footer: {
      marginTop: spacing.xl,
      alignItems: 'center',
    },
    footerLinkText: {
      fontSize: typography.sizes.sm,
      color: colors.textSecondary,
      fontWeight: typography.weights.medium,
    },
  });
