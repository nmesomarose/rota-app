import React, { useState, useRef, useMemo, useEffect } from 'react';
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
  Modal,
  Pressable,
  Image,
  Animated,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';
import { api, ApiError, getApiBaseUrl, setCustomApiUrl } from '../services/api.ts';
import {
  setAccessToken,
  setRefreshToken,
  setUserProfile,
  setActiveBusiness,
} from '../services/storage.ts';
import {
  registerForPushNotificationsAsync,
  resetSessionExpiredAlertState,
} from '../services/notifications.ts';
import { executeGoogleSignIn, type GoogleSignInResult } from '../services/google-auth.ts';
import { colors, typography, spacing, radii, shadows, useTheme, type ColorTokens } from '../theme/index.ts';

type Props = NativeStackScreenProps<RootStackParamList, 'Auth'>;

/**
 * Official branding-compliant Google logo mark.
 */
function GoogleLogo({ size = 20 }: { size?: number }) {
  return (
    <Image
      source={require('../../assets/google-logo.png')}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel="Google logo"
    />
  );
}

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

/**
 * Pure React Native celebration badge using core Animated and Ionicons.
 * Avoids external native animation modules to ensure 100% compatibility with installed APK binaries.
 */
function CelebrationBadge({ isDark }: { isDark: boolean }) {
  const scaleAnim = useRef(new Animated.Value(0.3)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 6,
        tension: 45,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 350,
        useNativeDriver: true,
      }),
    ]).start();
  }, [scaleAnim, opacityAnim]);

  return (
    <Animated.View
      style={[
        celebrationStyles.circle,
        {
          transform: [{ scale: scaleAnim }],
          opacity: opacityAnim,
          backgroundColor: isDark ? 'rgba(13, 148, 136, 0.2)' : '#CCFBF1',
          borderColor: isDark ? '#14B8A6' : '#0D9488',
        },
      ]}
    >
      <Ionicons
        name="checkmark-circle"
        size={72}
        color={isDark ? '#2DD4BF' : '#0D9488'}
      />
    </Animated.View>
  );
}

const celebrationStyles = StyleSheet.create({
  circle: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
});

export function LoginScreen({ navigation, route }: Props) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const isDev = Boolean(
    typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production'
  );

  const pendingInviteToken = route?.params?.pendingInviteToken;
  const initialMode = route?.params?.initialMode;
  const prefilledEmail = route?.params?.prefilledEmail;

  const [isSignUp, setIsSignUp] = useState(initialMode === 'signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState(prefilledEmail || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Google Sign-In & Account Linking state (FR-AUTH-002, FR-AUTH-011)
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showLinkingModal, setShowLinkingModal] = useState(false);
  const [linkingEmail, setLinkingEmail] = useState('');
  const [linkingIdToken, setLinkingIdToken] = useState('');
  const [linkingPassword, setLinkingPassword] = useState('');
  const [showLinkingPassword, setShowLinkingPassword] = useState(false);
  const [linkingLoading, setLinkingLoading] = useState(false);
  const [linkingError, setLinkingError] = useState<string | null>(null);

  // Confirmed registration success state
  const [registrationSuccess, setRegistrationSuccess] = useState(false);

  // Field focus management
  const emailInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);

  // Developer diagnostic modal & state (isolated to development runtime)
  const [serverUrl, setServerUrl] = useState(getApiBaseUrl());
  const [showDevModal, setShowDevModal] = useState(false);
  const [testingServer, setTestingServer] = useState(false);
  const [serverStatus, setServerStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const logoTapCountRef = useRef(0);
  const lastLogoTapTimeRef = useRef(0);

  const handleLogoPress = () => {
    if (!isDev) return;
    const now = Date.now();
    if (now - lastLogoTapTimeRef.current < 500) {
      logoTapCountRef.current += 1;
      if (logoTapCountRef.current >= 3) {
        logoTapCountRef.current = 0;
        setShowDevModal(true);
      }
    } else {
      logoTapCountRef.current = 1;
    }
    lastLogoTapTimeRef.current = now;
  };

  const handleTestConnection = async () => {
    setTestingServer(true);
    setServerStatus(null);
    try {
      const trimmed = serverUrl.trim().replace(/\/+$/, '');
      setCustomApiUrl(trimmed);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${trimmed}/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        setServerStatus({
          ok: true,
          message: 'Connected! Backend reachable on /health.',
        });
      } else {
        setServerStatus({
          ok: false,
          message: `Server returned HTTP ${res.status}.`,
        });
      }
    } catch {
      setServerStatus({
        ok: false,
        message: `Cannot reach server at ${serverUrl}. Ensure the backend is running (npm.cmd run dev) and on the same Wi-Fi.`,
      });
    } finally {
      setTestingServer(false);
    }
  };

  const hasMinLength = password.length >= 8;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  const allPasswordCriteriaMet = hasMinLength && hasLetter && hasNumber && hasSpecial;

  const toggleMode = (signUp: boolean) => {
    setIsSignUp(signUp);
    setErrorMessage(null);
  };

  const handleAuth = async () => {
    setErrorMessage(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setErrorMessage('Please enter your email address.');
      emailInputRef.current?.focus();
      return;
    }
    if (!password) {
      setErrorMessage('Please enter your password.');
      passwordInputRef.current?.focus();
      return;
    }
    if (isSignUp && (!hasMinLength || !hasLetter || !hasNumber || !hasSpecial)) {
      setErrorMessage('Password must satisfy all 4 compulsory requirements.');
      passwordInputRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      if (isSignUp) {
        const data = await api.auth.register(trimmedEmail, password, name.trim() || undefined);
        resetSessionExpiredAlertState();
        await setAccessToken(data.tokens.accessToken);
        await setRefreshToken(data.tokens.refreshToken);
        await setUserProfile(data.user);

        // Proactively register push token upon authenticated session creation
        registerForPushNotificationsAsync().catch(() => {});

        // Show tasteful success Lottie celebration upon confirmed backend registration
        setRegistrationSuccess(true);
        setTimeout(() => {
          if (pendingInviteToken) {
            navigation.replace('AcceptInvitation', { token: pendingInviteToken });
          } else {
            navigation.replace('BusinessSelect');
          }
        }, 1800);
      } else {
        const data = await api.auth.login(trimmedEmail, password);
        resetSessionExpiredAlertState();
        await setAccessToken(data.tokens.accessToken);
        await setRefreshToken(data.tokens.refreshToken);
        await setUserProfile(data.user);

        // Proactively register push token upon login
        registerForPushNotificationsAsync().catch(() => {});

        if (pendingInviteToken) {
          navigation.replace('AcceptInvitation', { token: pendingInviteToken });
        } else if (data.activeBusinessId && data.businesses.length === 1) {
          const active = data.businesses[0];
          await setActiveBusiness({
            id: active.business_id,
            name: active.business_name,
            role: active.role,
          });
          navigation.replace('Main', { screen: 'Schedule' });
        } else {
          navigation.replace('BusinessSelect');
        }
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.statusCode === 401) {
          setErrorMessage('Invalid email or password.');
        } else if (err.code === 'BUSINESS_CONTEXT_REQUIRED') {
          navigation.replace('BusinessSelect');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Unable to connect to Rota backend. Please verify your connection.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (googleLoading || loading) return;
    setErrorMessage(null);
    setGoogleLoading(true);

    try {
      const result = await executeGoogleSignIn();

      if (result.type === 'cancel') {
        // User voluntarily closed the sheet; no error banner needed
        return;
      }

      if (result.type === 'error') {
        setErrorMessage(result.message);
        return;
      }

      if (result.type === 'linking_required') {
        setLinkingEmail(result.email || email.trim());
        setLinkingIdToken(result.idToken);
        setLinkingError(null);
        setLinkingPassword('');
        setShowLinkingPassword(false);
        setShowLinkingModal(true);
        return;
      }

      if (result.type === 'success') {
        if (pendingInviteToken) {
          navigation.replace('AcceptInvitation', { token: pendingInviteToken });
        } else if (result.activeBusinessId && result.businesses.length === 1) {
          const active = result.businesses[0];
          await setActiveBusiness({
            id: active.business_id,
            name: active.business_name,
            role: active.role,
          });
          navigation.replace('Main', { screen: 'Schedule' });
        } else {
          navigation.replace('BusinessSelect');
        }
      }
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Google authentication encountered an unexpected error.'
      );
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleCloseLinkingModal = () => {
    if (linkingLoading) return;
    setShowLinkingModal(false);
    setLinkingPassword('');
    setShowLinkingPassword(false);
    setLinkingError(null);
  };

  const handleConfirmAccountLink = async () => {
    if (!linkingPassword) {
      setLinkingError('Please enter your account password to confirm.');
      return;
    }

    setLinkingLoading(true);
    setLinkingError(null);

    try {
      await api.auth.linkGoogleAccount(linkingEmail, linkingPassword, linkingIdToken);

      // Successfully linked; re-authenticate with Google ID token
      const authData = await api.auth.googleSignIn(linkingIdToken);
      setShowLinkingModal(false);
      resetSessionExpiredAlertState();
      await setAccessToken(authData.tokens.accessToken);
      await setRefreshToken(authData.tokens.refreshToken);
      await setUserProfile(authData.user);
      registerForPushNotificationsAsync().catch(() => {});

      if (pendingInviteToken) {
        navigation.replace('AcceptInvitation', { token: pendingInviteToken });
      } else if (authData.activeBusinessId && authData.businesses.length === 1) {
        const active = authData.businesses[0];
        await setActiveBusiness({
          id: active.business_id,
          name: active.business_name,
          role: active.role,
        });
        navigation.replace('Main', { screen: 'Schedule' });
      } else {
        navigation.replace('BusinessSelect');
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setLinkingError(err.message);
      } else {
        setLinkingError('Failed to link account. Please verify your password.');
      }
    } finally {
      setLinkingLoading(false);
    }
  };

  // Render registration celebration view upon confirmed backend success
  if (registrationSuccess) {
    return (
      <View style={styles.successContainer}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={styles.successCard}>
          <CelebrationBadge isDark={isDark} />
          <Text style={styles.successTitle}>Account Created!</Text>
          <Text style={styles.successSubtitle}>
            {pendingInviteToken
              ? 'Welcome to Rota. Redirecting to your pending invitation...'
              : 'Welcome to Rota. Redirecting to your workspace...'}
          </Text>
          <TouchableOpacity
            style={styles.successButton}
            onPress={() => {
              if (pendingInviteToken) {
                navigation.replace('AcceptInvitation', { token: pendingInviteToken });
              } else {
                navigation.replace('BusinessSelect');
              }
            }}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Continue"
          >
            <Text style={styles.successButtonText}>Continue</Text>
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
        {/* If in Sign Up mode, show top navigation back to Sign In */}
        {isSignUp && (
          <TouchableOpacity
            style={styles.backToSignInButton}
            onPress={() => toggleMode(false)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Back to sign in"
          >
            <Text style={styles.backToSignInText}>← Back to Sign In</Text>
          </TouchableOpacity>
        )}

        {/* Brand Header with Actual Rota Icon Image */}
        <View style={styles.header}>
          <Pressable
            onPress={handleLogoPress}
            style={styles.logoPressable}
            accessibilityRole="button"
            accessibilityHint="Triple tap for backend connection settings"
          >
            <Image
              source={require('../../assets/icon.png')}
              style={styles.logoImage}
              resizeMode="contain"
            />
          </Pressable>
          <Text style={styles.appTitle}>{isSignUp ? 'Create Account' : 'Sign In to Rota'}</Text>
          <Text style={styles.appSubtitle}>
            {isSignUp
              ? 'Set up your profile to start scheduling and managing staff'
              : 'Workforce Scheduling Platform'}
          </Text>
        </View>

        {/* Dedicated Clean Form Card (Segregated Sign In vs Sign Up) */}
        <View style={styles.card}>
          {/* Pending Invitation Context Banner */}
          {pendingInviteToken && (
            <View style={styles.inviteNoticeBanner}>
              <Text style={styles.inviteNoticeTitle}>Pending Team Invitation</Text>
              <Text style={styles.inviteNoticeText}>
                {isSignUp
                  ? 'Complete your registration to accept the invitation and join your team.'
                  : 'Sign in to review and accept your invitation.'}
              </Text>
            </View>
          )}

          {/* Error Banner */}
          {errorMessage && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{errorMessage}</Text>
              {isDev && errorMessage.includes('Unable to connect') && (
                <TouchableOpacity
                  onPress={() => setShowDevModal(true)}
                  style={styles.errorDiagnoseLink}
                >
                  <Text style={styles.errorDiagnoseText}>Diagnose backend connection →</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Continue with Google Action (FR-AUTH-002) */}
          <TouchableOpacity
            style={[styles.googleButton, (loading || googleLoading) && styles.buttonDisabled]}
            onPress={handleGoogleSignIn}
            disabled={loading || googleLoading}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
          >
            {googleLoading ? (
              <ActivityIndicator color={colors.textPrimary} size="small" />
            ) : (
              <View style={styles.googleButtonContent}>
                <GoogleLogo size={20} />
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </View>
            )}
          </TouchableOpacity>

          {/* Separator Divider */}
          <View style={styles.orDividerContainer}>
            <View style={styles.orDividerLine} />
            <Text style={styles.orDividerText}>or continue with email</Text>
            <View style={styles.orDividerLine} />
          </View>

          {/* Sign Up: Full Name Input (ONLY on Create Account Page) */}
          {isSignUp && (
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Full Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Jane Doe"
                placeholderTextColor="#94A3B8"
                autoCapitalize="words"
                autoComplete="name"
                textContentType="name"
                returnKeyType="next"
                onSubmitEditing={() => emailInputRef.current?.focus()}
                value={name}
                onChangeText={setName}
                editable={!loading}
                accessibilityLabel="Full Name input"
              />
            </View>
          )}

          {/* Email Address */}
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
              returnKeyType="next"
              onSubmitEditing={() => passwordInputRef.current?.focus()}
              value={email}
              onChangeText={setEmail}
              editable={!loading}
              accessibilityLabel="Email Address input"
            />
          </View>

          {/* Password with Eye Toggle */}
          <View style={styles.inputGroup}>
            <View style={styles.passwordHeaderRow}>
              <Text style={styles.label}>Password</Text>
              {!isSignUp && (
                <TouchableOpacity
                  onPress={() =>
                    navigation.navigate('ForgotPassword', {
                      prefilledEmail: email.trim(),
                    })
                  }
                  disabled={loading}
                  accessibilityRole="button"
                  accessibilityLabel="Forgot Password"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
                </TouchableOpacity>
              )}
            </View>
            <View
              style={[
                styles.passwordContainer,
                isSignUp && allPasswordCriteriaMet && styles.passwordContainerValid,
              ]}
            >
              <TextInput
                ref={passwordInputRef}
                style={styles.passwordInput}
                placeholder={isSignUp ? 'Create a secure password' : 'Enter your password'}
                placeholderTextColor="#94A3B8"
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete={isSignUp ? 'new-password' : 'password'}
                textContentType={isSignUp ? 'newPassword' : 'password'}
                returnKeyType={isSignUp ? 'done' : 'go'}
                onSubmitEditing={handleAuth}
                value={password}
                onChangeText={setPassword}
                editable={!loading}
                accessibilityLabel="Password input"
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setShowPassword((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                accessibilityHint="Toggles password visibility"
                activeOpacity={0.7}
              >
                <EyeIcon visible={showPassword} color="#64748B" />
              </TouchableOpacity>
            </View>

            {/* Compulsory Password Requirements Checklist - ONLY ON SIGN UP PAGE */}
            {isSignUp && (
              <View style={styles.checklistContainer}>
                <Text style={styles.checklistTitle}>Compulsory Password Requirements:</Text>

                {/* 1. At least 8 characters */}
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

                {/* 2. At least one letter */}
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

                {/* 3. At least one number */}
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

                {/* 4. At least one special character */}
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
            )}
          </View>

          {/* Primary Action Button */}
          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleAuth}
            disabled={loading}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={isSignUp ? 'Create Account' : 'Sign In'}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.buttonText}>{isSignUp ? 'Create My Account' : 'Sign In to Rota'}</Text>
            )}
          </TouchableOpacity>

          {/* Mode Switch Footer (Separate Page Toggle) */}
          <TouchableOpacity
            style={styles.toggleFooter}
            onPress={() => toggleMode(!isSignUp)}
            disabled={loading}
            accessibilityRole="button"
          >
            <Text style={styles.toggleFooterText}>
              {isSignUp ? 'Already have an account? ' : "Don't have an account? "}
              <Text style={styles.toggleFooterHighlight}>
                {isSignUp ? 'Sign In' : 'Create an Account'}
              </Text>
            </Text>
          </TouchableOpacity>
        </View>

        {/* Discreet Diagnostics Link for Testing (Development Only) */}
        {Boolean(typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production') && (
          <View style={styles.discreetFooter}>
            <TouchableOpacity
              onPress={() => setShowDevModal(true)}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="Backend settings"
            >
              <Text style={styles.discreetFooterText}>
                Backend: {serverUrl.replace(/^https?:\/\//, '')}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Developer Diagnostic Modal (Isolated to Development Runtime) */}
      {isDev && (
        <Modal
          visible={showDevModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowDevModal(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Backend Diagnostic</Text>
                <TouchableOpacity
                  onPress={() => setShowDevModal(false)}
                  style={styles.modalCloseButton}
                >
                  <Text style={styles.modalCloseText}>✕</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.modalDescription}>
                Configure the API base URL used by Expo Go to reach the host machine.
              </Text>

              <Text style={styles.modalLabel}>Server URL (IP:Port)</Text>
              <TextInput
                style={styles.modalInput}
                value={serverUrl}
                onChangeText={(val) => {
                  setServerUrl(val);
                  setCustomApiUrl(val);
                }}
                placeholder="http://172.20.10.13:3000"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <TouchableOpacity
                style={[styles.modalTestButton, testingServer && styles.buttonDisabled]}
                onPress={handleTestConnection}
                disabled={testingServer}
              >
                {testingServer ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.modalTestButtonText}>Test /health Connection</Text>
                )}
              </TouchableOpacity>

              {serverStatus && (
                <View
                  style={[
                    styles.modalStatusBanner,
                    serverStatus.ok ? styles.modalStatusBannerOk : styles.modalStatusBannerErr,
                  ]}
                >
                  <Text
                    style={[
                      styles.modalStatusText,
                      serverStatus.ok ? styles.modalStatusTextOk : styles.modalStatusTextErr,
                    ]}
                  >
                    {serverStatus.message}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={styles.modalSaveButton}
                onPress={() => setShowDevModal(false)}
              >
                <Text style={styles.modalSaveButtonText}>Save & Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {/* Account Linking Modal (FR-AUTH-011, SEC-019) */}
      <Modal
        visible={showLinkingModal}
        transparent
        animationType="fade"
        onRequestClose={handleCloseLinkingModal}
        accessibilityViewIsModal={true}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={styles.modalTitleContainer}>
                <Image
                  source={require('../../assets/google-logo.png')}
                  style={styles.modalGoogleBadge}
                  resizeMode="contain"
                  accessibilityLabel="Google icon"
                />
                <Text style={styles.modalTitle}>Link Google Account</Text>
              </View>
              <TouchableOpacity
                onPress={handleCloseLinkingModal}
                style={styles.modalCloseButton}
                accessibilityRole="button"
                accessibilityLabel="Close modal"
                disabled={linkingLoading}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.modalDescription}>
              An account already exists with{' '}
              <Text style={styles.modalHighlightEmail}>{linkingEmail || 'this email address'}</Text>.
              To protect against unauthorised identity takeovers, enter your existing password to
              link your Google identity.
            </Text>

            {linkingError && (
              <View
                style={styles.modalErrorBanner}
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                <Text style={styles.modalErrorText}>{linkingError}</Text>
              </View>
            )}

            <View style={styles.modalPasswordHeaderRow}>
              <Text style={styles.modalLabel}>Existing Account Password</Text>
              <TouchableOpacity
                onPress={() => {
                  setShowLinkingModal(false);
                  navigation.navigate('ForgotPassword', {
                    prefilledEmail: linkingEmail,
                  });
                }}
                disabled={linkingLoading}
                accessibilityRole="button"
                accessibilityLabel="Forgot password for existing account"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalForgotPasswordText}>Forgot Password?</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalPasswordContainer}>
              <TextInput
                style={styles.modalPasswordInput}
                placeholder="Enter password"
                placeholderTextColor="#94A3B8"
                secureTextEntry={!showLinkingPassword}
                autoCapitalize="none"
                autoCorrect={false}
                value={linkingPassword}
                onChangeText={setLinkingPassword}
                onSubmitEditing={handleConfirmAccountLink}
                editable={!linkingLoading}
                returnKeyType="done"
                accessibilityLabel="Existing Account Password input"
                accessibilityHint="Enter your existing account password to confirm account linking"
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setShowLinkingPassword((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={showLinkingPassword ? 'Hide password' : 'Show password'}
                accessibilityHint="Toggles password visibility"
                activeOpacity={0.7}
                disabled={linkingLoading}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <EyeIcon visible={showLinkingPassword} color="#64748B" />
              </TouchableOpacity>
            </View>

            <View style={styles.modalActionButtons}>
              <TouchableOpacity
                style={[styles.modalSaveButton, linkingLoading && styles.buttonDisabled]}
                onPress={handleConfirmAccountLink}
                disabled={linkingLoading}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Confirm and link account"
              >
                {linkingLoading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.modalSaveButtonText}>Confirm & Link Account</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={handleCloseLinkingModal}
                disabled={linkingLoading}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Cancel linking"
              >
                <Text style={styles.modalCancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingVertical: 36,
    },
    header: {
      alignItems: 'center',
      marginBottom: 28,
    },
    backToSignInButton: {
      alignSelf: 'flex-start',
      marginBottom: 16,
      paddingVertical: 8,
      paddingHorizontal: 12,
      backgroundColor: colors.surfaceSubtle,
      borderRadius: 8,
    },
    backToSignInText: {
      color: colors.primaryNavy,
      fontSize: 13,
      fontWeight: '600',
    },
    logoPressable: {
      marginBottom: 14,
      shadowColor: colors.primaryNavy,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 10,
      elevation: 4,
    },
    logoImage: {
      width: 68,
      height: 68,
      borderRadius: 16,
    },
    logoBadgeText: {
      color: colors.lightTeal,
      fontSize: 28,
      fontWeight: '800',
      letterSpacing: -0.5,
    },
    appTitle: {
      fontSize: 30,
      fontWeight: '800',
      color: colors.primaryNavy,
      letterSpacing: -0.5,
    },
    appSubtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      marginTop: 4,
      fontWeight: '500',
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      padding: 24,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.primaryNavy,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.06,
      shadowRadius: 16,
      elevation: 2,
    },
    tabContainer: {
      flexDirection: 'row',
      backgroundColor: colors.surfaceSubtle,
      borderRadius: 12,
      padding: 4,
      marginBottom: 22,
    },
    tab: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
      borderRadius: 9,
    },
    activeTab: {
      backgroundColor: colors.surface,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 4,
      elevation: 1,
    },
    tabText: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.textSecondary,
    },
    activeTabText: {
      color: colors.textPrimary,
      fontWeight: '600',
    },
    inviteNoticeBanner: {
      backgroundColor: colors.surfaceSubtle,
      borderColor: colors.primaryTeal,
      borderWidth: 1.5,
      borderRadius: 12,
      padding: 14,
      marginBottom: 18,
    },
    inviteNoticeTitle: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.primaryTeal,
      marginBottom: 4,
    },
    inviteNoticeText: {
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    errorBanner: {
      backgroundColor: colors.errorLight,
      borderColor: colors.errorBorder,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      marginBottom: 18,
    },
    errorText: {
      color: colors.errorText,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '500',
    },
    errorDiagnoseLink: {
      marginTop: 6,
    },
    errorDiagnoseText: {
      color: colors.primaryTeal,
      fontSize: 12,
      fontWeight: '600',
    },
    inputGroup: {
      marginBottom: 16,
    },
    passwordHeaderRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 6,
    },
    forgotPasswordText: {
      fontSize: 12,
      color: colors.primaryTeal,
      fontWeight: '600',
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary,
      marginBottom: 6,
    },
    input: {
      backgroundColor: colors.surfaceSubtle,
      borderColor: colors.border,
      borderWidth: 1.5,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.textPrimary,
      fontSize: 15,
    },
    passwordContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surfaceSubtle,
      borderColor: colors.border,
      borderWidth: 1.5,
      borderRadius: 10,
    },
    passwordContainerValid: {
      borderColor: colors.successBorder,
      backgroundColor: isDark ? '#052E16' : '#F0FDF4',
    },
    passwordInput: {
      flex: 1,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.textPrimary,
      fontSize: 15,
    },
    checklistContainer: {
      marginTop: 10,
      padding: 12,
      backgroundColor: colors.surfaceSubtle,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    checklistTitle: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.textPrimary,
      marginBottom: 8,
    },
    checklistItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 5,
      paddingHorizontal: 8,
      borderRadius: 6,
      marginBottom: 4,
    },
    checklistItemValid: {
      backgroundColor: colors.successLight,
    },
    checklistIconBadge: {
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: isDark ? '#334155' : '#E2E8F0',
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 8,
    },
    checklistIconBadgeValid: {
      backgroundColor: colors.success,
    },
    checklistIconText: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textSecondary,
      lineHeight: 13,
    },
    checklistIconTextValid: {
      color: '#FFFFFF',
      fontWeight: '900',
    },
    checklistLabel: {
      fontSize: 12,
      color: colors.textSecondary,
      fontWeight: '500',
    },
    checklistLabelValid: {
      color: colors.success,
      fontWeight: '600',
    },
    formModeHeader: {
      marginBottom: 16,
    },
    formModeTitle: {
      fontSize: 17,
      fontWeight: '700',
      color: colors.textPrimary,
      marginBottom: 4,
    },
    formModeSubtitle: {
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    eyeButton: {
      paddingHorizontal: 12,
      paddingVertical: 10,
      justifyContent: 'center',
      alignItems: 'center',
    },
    button: {
      backgroundColor: colors.primaryTeal,
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      marginTop: 8,
      shadowColor: colors.primaryTeal,
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
      elevation: 3,
    },
    buttonDisabled: {
      opacity: 0.65,
    },
    buttonText: {
      color: '#FFFFFF',
      fontWeight: '600',
      fontSize: 16,
    },
    toggleFooter: {
      marginTop: 18,
      alignItems: 'center',
      paddingVertical: 6,
    },
    toggleFooterText: {
      fontSize: 13,
      color: colors.textSecondary,
    },
    toggleFooterHighlight: {
      color: colors.primaryTeal,
      fontWeight: '600',
    },
    discreetFooter: {
      marginTop: 24,
      alignItems: 'center',
    },
    discreetFooterText: {
      fontSize: 11,
      color: colors.textMuted,
      fontWeight: '500',
    },
    // Success Celebration View
    successContainer: {
      flex: 1,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    successCard: {
      backgroundColor: colors.surface,
      borderRadius: 24,
      padding: 32,
      alignItems: 'center',
      width: '100%',
      maxWidth: 380,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.08,
      shadowRadius: 20,
      elevation: 4,
    },
    lottie: {
      width: 120,
      height: 120,
    },
    successTitle: {
      fontSize: 24,
      fontWeight: '800',
      color: colors.textPrimary,
      marginTop: 12,
      letterSpacing: -0.3,
    },
    successSubtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: 6,
      lineHeight: 20,
    },
    successButton: {
      backgroundColor: colors.primaryTeal,
      paddingVertical: 12,
      paddingHorizontal: 28,
      borderRadius: 10,
      marginTop: 24,
      width: '100%',
      alignItems: 'center',
    },
    successButtonText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '600',
    },
    // Dev Diagnostic Modal Styles
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.backdrop,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 20,
    },
    modalContent: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 22,
      width: '100%',
      maxWidth: 420,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.15,
      shadowRadius: 24,
      elevation: 6,
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    modalCloseButton: {
      padding: 6,
    },
    modalCloseText: {
      fontSize: 16,
      color: colors.textSecondary,
      fontWeight: '600',
    },
    modalDescription: {
      fontSize: 13,
      color: colors.textSecondary,
      marginBottom: 16,
      lineHeight: 18,
    },
    modalLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textPrimary,
      marginBottom: 6,
    },
    modalInput: {
      backgroundColor: colors.surfaceSubtle,
      borderColor: colors.border,
      borderWidth: 1.5,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      color: colors.textPrimary,
      marginBottom: 12,
    },
    modalTestButton: {
      backgroundColor: isDark ? colors.surfaceSubtle : '#0F172A',
      paddingVertical: 11,
      borderRadius: 8,
      alignItems: 'center',
    },
    modalTestButtonText: {
      color: '#FFFFFF',
      fontSize: 13,
      fontWeight: '600',
    },
    modalStatusBanner: {
      marginTop: 12,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
    },
    modalStatusBannerOk: {
      backgroundColor: '#ECFDF5',
      borderColor: '#10B981',
    },
    modalStatusBannerErr: {
      backgroundColor: '#FEF2F2',
      borderColor: '#EF4444',
    },
    modalStatusText: {
      fontSize: 12,
      lineHeight: 16,
    },
    modalStatusTextOk: {
      color: '#065F46',
    },
    modalStatusTextErr: {
      color: '#991B1B',
    },
    modalSaveButton: {
      backgroundColor: colors.primaryTeal,
      paddingVertical: 12,
      borderRadius: radii.md,
      alignItems: 'center',
    },
    modalSaveButtonText: {
      color: '#FFFFFF',
      fontSize: 14,
      fontWeight: '600',
    },
    modalTitleContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    modalGoogleBadge: {
      width: 22,
      height: 22,
    },
    modalHighlightEmail: {
      fontWeight: '700',
      color: colors.textPrimary,
    },
    modalPasswordHeaderRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 6,
    },
    modalForgotPasswordText: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.primaryNavy,
    },
    modalPasswordContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surfaceSubtle,
      borderColor: colors.border,
      borderWidth: 1.5,
      borderRadius: radii.md,
      paddingHorizontal: 12,
      marginBottom: 16,
    },
    modalPasswordInput: {
      flex: 1,
      height: 48,
      fontSize: 14,
      color: colors.textPrimary,
      paddingVertical: 10,
    },
    modalActionButtons: {
      marginTop: 4,
      gap: 10,
    },
    modalCancelButton: {
      paddingVertical: 10,
      alignItems: 'center',
      borderRadius: radii.md,
    },
    modalCancelButtonText: {
      color: colors.textSecondary,
      fontSize: 14,
      fontWeight: '600',
    },
    // Google Sign-In & Divider Styles
    googleButton: {
      backgroundColor: colors.surfaceSubtle,
      borderColor: colors.border,
      borderWidth: 1.5,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 3,
      elevation: 1,
    },
    googleButtonContent: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    googleButtonText: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    orDividerContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 18,
    },
    orDividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: colors.border,
    },
    orDividerText: {
      paddingHorizontal: 12,
      fontSize: 12,
      fontWeight: '500',
      color: colors.textSecondary,
    },
    modalErrorBanner: {
      backgroundColor: colors.errorLight,
      borderColor: colors.errorBorder,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      marginBottom: 12,
    },
    modalErrorText: {
      color: colors.errorText,
      fontSize: 12,
      lineHeight: 16,
    },
  });
