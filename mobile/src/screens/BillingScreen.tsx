import React, { useEffect, useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  Modal,
  Linking,
  AppState,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../services/api.ts';
import { getActiveBusiness, type StoredBusiness } from '../services/storage.ts';
import { evaluateBillingQuote } from '../services/billing-helpers.ts';
import { typography, spacing, radii, shadows, type ColorTokens } from '../theme/tokens.ts';
import { useTheme } from '../theme/ThemeContext.tsx';

export function BillingScreen({ navigation }: any) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);

  const [business, setBusiness] = useState<StoredBusiness | null>(null);
  const [subscription, setSubscription] = useState<any | null>(null);
  const [ledger, setLedger] = useState<any[]>([]);
  const [paymentHistory, setPaymentHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Quote State
  const [quote, setQuote] = useState<any | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<'team' | 'business'>('team');
  const [selectedCurrency, setSelectedCurrency] = useState<'USD' | 'NGN'>('USD');
  const [extraSeats, setExtraSeats] = useState<number>(0);

  // Paystack Checkout & Verification State
  const [activePaymentIntent, setActivePaymentIntent] = useState<any | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [verifyingPayment, setVerifyingPayment] = useState(false);

  // Keep a reference to the active/pending transaction for AppState listeners
  const pendingRef = useRef<string | null>(null);
  pendingRef.current =
    activePaymentIntent?.providerReference || subscription?.pendingIntent?.providerReference || null;

  useEffect(() => {
    loadData();

    // Deep link listener for Paystack return callback (rota://billing/return?reference=...)
    const linkSub = Linking.addEventListener('url', async ({ url }) => {
      if (url && url.includes('billing/return')) {
        try {
          const match = url.match(/[?&](?:reference|trxref)=([^&#]+)/);
          if (match && match[1]) {
            const ref = decodeURIComponent(match[1]);
            await handleVerifyPayment(ref);
          }
        } catch {
          // Handled gracefully; modal remains available
        }
      }
    });

    // AppState listener: automatically verifies & unlocks app as soon as user returns to foreground
    const appStateSub = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active') {
        const targetRef = pendingRef.current;
        if (targetRef) {
          await handleVerifyPayment(targetRef, true);
        } else {
          // Refresh subscription data to reflect any server-side webhook/redirect fulfillments
          try {
            const subRes = await api.billing.getSubscription();
            setSubscription(subRes.data);
          } catch {
            // Ignore background refresh errors
          }
        }
      }
    });

    return () => {
      linkSub.remove();
      appStateSub.remove();
    };
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const biz = await getActiveBusiness();
      setBusiness(biz);

      // Enforce owner authorization guard: non-owners cannot query subscription endpoints (PRD 4.5)
      if (biz?.role?.toLowerCase() !== 'owner') {
        setLoading(false);
        return;
      }

      const subRes = await api.billing.getSubscription();
      setSubscription(subRes.data);
      if (subRes.data?.billingCurrency) {
        setSelectedCurrency(subRes.data.billingCurrency as 'USD' | 'NGN');
      }

      const [ledgerRes, historyRes] = await Promise.all([
        api.billing.getLedger().catch(() => ({ data: [] })),
        api.billing.getHistory().catch(() => ({ data: [] })),
      ]);
      setLedger(ledgerRes.data || []);
      setPaymentHistory(historyRes.data || []);
    } catch (err: any) {
      Alert.alert('Billing Error', err.message || 'Failed to load subscription details');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestQuote = async () => {
    setActionLoading(true);
    try {
      const included = selectedPlan === 'team' ? 15 : 40;
      const targetSeats = included + extraSeats;

      const res = await api.billing.createQuote({
        targetPlan: selectedPlan,
        targetSeats,
        currency: selectedCurrency,
      });
      setQuote(res.data);
    } catch (err: any) {
      Alert.alert('Quote Error', err.message || 'Failed to generate quote');
    } finally {
      setActionLoading(false);
    }
  };

  const launchPaystackCheckout = async (checkoutUrl: string, providerReference: string) => {
    try {
      await WebBrowser.openBrowserAsync(checkoutUrl, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        controlsColor: colors.primaryTeal,
        dismissButtonStyle: 'done',
      });
      // When the user finishes or taps Done, immediately auto-verify and unlock
      await handleVerifyPayment(providerReference, false);
    } catch {
      try {
        await Linking.openURL(checkoutUrl);
      } catch {
        // Handled gracefully
      }
    }
  };

  const handleConfirmAndPay = async () => {
    if (!quote) return;
    setActionLoading(true);
    try {
      const idempotencyKey = `mob_quote_${Date.now()}`;
      const confirmRes = await api.billing.confirmQuote(quote.id, idempotencyKey);
      const intent = confirmRes.data;

      setActivePaymentIntent(intent);
      setShowPaymentModal(true);

      // Open Paystack checkout in an in-app browser sheet so user never leaves Rota
      if (intent.checkoutUrl) {
        launchPaystackCheckout(intent.checkoutUrl, intent.providerReference);
      }
    } catch (err: any) {
      if (
        err?.code === 'PAYMENT_PENDING' ||
        (err?.message && err.message.toLowerCase().includes('intent is currently pending'))
      ) {
        Alert.alert(
          'Existing Checkout Pending',
          'Another payment session is already pending for this business. Would you like to cancel it and proceed with this new payment?',
          [
            { text: 'Keep Existing', style: 'cancel' },
            {
              text: 'Cancel Old & Pay',
              style: 'destructive',
              onPress: async () => {
                setActionLoading(true);
                try {
                  await api.billing.cancelPayment();
                  const idempotencyKey = `mob_quote_${Date.now()}`;
                  const retryRes = await api.billing.confirmQuote(quote.id, idempotencyKey, {
                    cancelPending: true,
                  });
                  const intent = retryRes.data;
                  setActivePaymentIntent(intent);
                  setShowPaymentModal(true);
                  if (intent.checkoutUrl) {
                    launchPaystackCheckout(intent.checkoutUrl, intent.providerReference);
                  }
                } catch (retryErr: any) {
                  Alert.alert('Checkout Error', retryErr.message || 'Failed to start payment');
                } finally {
                  setActionLoading(false);
                }
              },
            },
          ]
        );
      } else {
        Alert.alert('Checkout Error', err.message || 'Failed to initiate checkout session');
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelPendingPayment = async () => {
    setActionLoading(true);
    try {
      await api.billing.cancelPayment();
      setActivePaymentIntent(null);
      setShowPaymentModal(false);
      Alert.alert(
        'Payment Session Cancelled',
        'The pending checkout has been cancelled. You can now request a new quote or start fresh.'
      );
      await loadData();
    } catch (err: any) {
      Alert.alert('Cancellation Error', err.message || 'Failed to cancel pending checkout');
    } finally {
      setActionLoading(false);
    }
  };

  const handleVerifyPayment = async (refOverride?: unknown, silentOnPending = false) => {
    const targetRef =
      typeof refOverride === 'string'
        ? refOverride
        : activePaymentIntent?.providerReference || subscription?.pendingIntent?.providerReference;
    if (!targetRef) return;
    setVerifyingPayment(true);
    try {
      const res = await api.billing.verifyPayment(targetRef);
      if (res.data?.status === 'succeeded') {
        setShowPaymentModal(false);
        setActivePaymentIntent(null);
        Alert.alert(
          'Payment Verified',
          `Entitlement granted: Upgraded to ${quote?.targetPlan?.toUpperCase() || res.data?.subscription?.plan?.toUpperCase() || 'NEW PLAN'} with ${quote?.targetSeats || res.data?.subscription?.seatQuantity || 'updated'} seats!`
        );
        setQuote(null);
        await loadData();
      } else if (res.data?.status === 'pending') {
        if (!silentOnPending) {
          Alert.alert(
            'Payment Pending',
            'Paystack has not confirmed this payment yet. Please complete checkout in your browser window and try verifying again.'
          );
        }
      } else {
        if (!silentOnPending) {
          Alert.alert(
            'Payment Incomplete',
            res.data?.message || 'Transaction was not completed or failed.'
          );
        }
      }
    } catch (err: any) {
      if (!silentOnPending) {
        Alert.alert('Verification Error', err.message || 'Failed to verify transaction with server');
      }
    } finally {
      setVerifyingPayment(false);
    }
  };

  const handleScheduleDowngrade = async (targetPlan: string) => {
    setActionLoading(true);
    try {
      await api.billing.scheduleDowngrade({ targetPlan });
      Alert.alert('Downgrade Scheduled', `Plan will switch to ${targetPlan.toUpperCase()} at the end of the period.`);
      await loadData();
    } catch (err: any) {
      Alert.alert('Schedule Error', err.message || 'Failed to schedule downgrade');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelDowngrade = async () => {
    setActionLoading(true);
    try {
      await api.billing.cancelScheduledDowngrade();
      Alert.alert('Cancelled', 'Scheduled downgrade has been cancelled.');
      await loadData();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to cancel downgrade');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={colors.primaryTeal} />
        <Text style={styles.loadingText}>Loading subscription data...</Text>
      </View>
    );
  }

  const isOwner = business?.role?.toLowerCase() === 'owner';

  if (!isOwner) {
    return (
      <View style={styles.restrictedContainer}>
        <View style={styles.restrictedCard}>
          <View style={styles.restrictedIconBadge}>
            <Ionicons name="shield-outline" size={40} color={colors.primaryTeal} />
          </View>
          <Text style={styles.restrictedTitle}>Access Restricted</Text>
          <Text style={styles.restrictedMessage}>
            Subscription management, plan tiers, quotes, and payment controls are restricted to Organization Owners (PRD Section 4.5).
          </Text>
          <TouchableOpacity
            style={styles.returnButton}
            onPress={() => (navigation?.canGoBack?.() ? navigation.goBack() : navigation?.navigate('Main', { screen: 'Schedule' }))}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Return to schedule"
          >
            <Ionicons name="arrow-back-outline" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />
            <Text style={styles.returnButtonText}>Return to Schedule</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.keyboardContainer}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Payment Provider Banner */}
        <View style={styles.simulatedBanner}>
          <Text style={styles.simulatedBannerTitle}>PAYSTACK PAYMENT PROVIDER (TEST MODE)</Text>
          <Text style={styles.simulatedBannerSubtitle}>
            Hosted checkout sessions are processed securely via Paystack in test mode. No live credit cards or real money are charged.
          </Text>
        </View>

        {/* Active Pending Checkout Banner */}
        {Boolean(subscription?.pendingIntent || activePaymentIntent) && (
          <View style={styles.pendingIntentBanner}>
            <View style={styles.pendingIntentHeaderRow}>
              <View style={styles.pendingIntentTitleGroup}>
                <Ionicons name="alert-circle" size={20} color="#D97706" style={{ marginRight: 6 }} />
                <Text style={styles.pendingIntentTitle}>Pending Payment Session</Text>
              </View>
              <View style={styles.pendingIntentBadge}>
                <Text style={styles.pendingIntentBadgeText}>AWAITING PAYMENT</Text>
              </View>
            </View>

            <Text style={styles.pendingIntentSubtitle}>
              Ref: {subscription?.pendingIntent?.providerReference || activePaymentIntent?.providerReference}
            </Text>
            <Text style={styles.pendingIntentDescription}>
              A payment intent has been created. If you completed payment in Safari, verify your status to activate your plan. Or cancel it below to unlock a new checkout.
            </Text>

            <View style={styles.pendingIntentActions}>
              <TouchableOpacity
                style={styles.pendingVerifyAction}
                onPress={() =>
                  handleVerifyPayment(
                    subscription?.pendingIntent?.providerReference || activePaymentIntent?.providerReference
                  )
                }
                disabled={verifyingPayment || actionLoading}
                activeOpacity={0.8}
              >
                {verifyingPayment ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.pendingVerifyActionText}>Verify Payment</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.pendingCancelAction}
                onPress={handleCancelPendingPayment}
                disabled={actionLoading || verifyingPayment}
                activeOpacity={0.8}
              >
                {actionLoading ? (
                  <ActivityIndicator size="small" color="#DC2626" />
                ) : (
                  <Text style={styles.pendingCancelActionText}>Cancel Session</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Subscription Details Card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Subscription Details</Text>
            <View style={[styles.badge, subscription?.status === 'active' ? styles.badgeActive : styles.badgeRestricted]}>
              <Text
                style={[
                  styles.badgeText,
                  subscription?.status === 'active' ? styles.badgeTextActive : styles.badgeTextRestricted,
                ]}
              >
                {subscription?.status?.toUpperCase()}
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Plan Tier</Text>
            <Text style={styles.infoValueHighlight}>{subscription?.plan?.toUpperCase()}</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Seat Utilization</Text>
            <Text style={styles.infoValue}>
              {subscription?.activeSeatUsage} / {subscription?.seatQuantity} seats
            </Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Admission Limit</Text>
            <Text style={styles.infoValue}>{subscription?.admissionLimit} seats</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Billing Period</Text>
            <Text style={styles.infoValue}>
              {subscription?.periodStartDate} → {subscription?.periodEndDate}
            </Text>
          </View>

          {subscription?.scheduledPlan && (
            <View style={styles.scheduledBanner}>
              <Text style={styles.scheduledText}>
                📅 Downgrade to {subscription.scheduledPlan.toUpperCase()} scheduled for next renewal.
              </Text>
              {isOwner && (
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={handleCancelDowngrade}
                  disabled={actionLoading}
                  activeOpacity={0.8}
                >
                  <Text style={styles.cancelButtonText}>Cancel Scheduled Downgrade</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        {/* Owner-Only Upgrade Section (BR-006) */}
        {isOwner ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Plan Upgrade & Additional Seats</Text>
            <Text style={styles.sectionSubtitle}>
              Server-calculated prorated quote with indicative CBN fixture exchange rates.
            </Text>

            {/* Plan Selector */}
            <View style={styles.selectorRow}>
              <TouchableOpacity
                style={[styles.selectorButton, selectedPlan === 'team' && styles.selectorButtonActive]}
                onPress={() => setSelectedPlan('team')}
                activeOpacity={0.8}
              >
                <Text style={[styles.selectorText, selectedPlan === 'team' && styles.selectorTextActive]}>
                  Team ($50/mo)
                </Text>
                <Text style={styles.selectorSubtext}>15 included seats</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.selectorButton, selectedPlan === 'business' && styles.selectorButtonActive]}
                onPress={() => setSelectedPlan('business')}
                activeOpacity={0.8}
              >
                <Text style={[styles.selectorText, selectedPlan === 'business' && styles.selectorTextActive]}>
                  Business ($120/mo)
                </Text>
                <Text style={styles.selectorSubtext}>40 included seats</Text>
              </TouchableOpacity>
            </View>

            {/* Currency Selector */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.inputLabel}>Billing Currency</Text>
              {subscription?.billingCurrency && (
                <Text style={styles.currentCurrencyNote}>
                  Active plan: {subscription.billingCurrency}
                </Text>
              )}
            </View>
            <View style={styles.currencyRow}>
              <TouchableOpacity
                style={[styles.currencyButton, selectedCurrency === 'USD' && styles.currencyButtonActive]}
                onPress={() => setSelectedCurrency('USD')}
                activeOpacity={0.8}
              >
                <Text style={[styles.currencyText, selectedCurrency === 'USD' && styles.currencyTextActive]}>
                  USD ($ Base)
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.currencyButton, selectedCurrency === 'NGN' && styles.currencyButtonActive]}
                onPress={() => setSelectedCurrency('NGN')}
                activeOpacity={0.8}
              >
                <Text style={[styles.currencyText, selectedCurrency === 'NGN' && styles.currencyTextActive]}>
                  NGN (₦ Fixture)
                </Text>
              </TouchableOpacity>
            </View>

            {/* Extra Seats Counter */}
            <Text style={styles.inputLabel}>Additional Seats Beyond Included</Text>
            <View style={styles.counterRow}>
              <TouchableOpacity
                style={styles.counterBtn}
                onPress={() => setExtraSeats(Math.max(0, extraSeats - 1))}
                activeOpacity={0.7}
              >
                <Text style={styles.counterBtnText}>-</Text>
              </TouchableOpacity>
              <View style={styles.counterValueContainer}>
                <Text style={styles.counterValue}>+{extraSeats} seats</Text>
              </View>
              <TouchableOpacity
                style={styles.counterBtn}
                onPress={() => setExtraSeats(extraSeats + 1)}
                activeOpacity={0.7}
              >
                <Text style={styles.counterBtnText}>+</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.actionButton, actionLoading && styles.buttonDisabled]}
              onPress={handleRequestQuote}
              disabled={actionLoading}
              activeOpacity={0.8}
            >
              {actionLoading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.actionButtonText}>Generate Server Quote</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Owner Role Required</Text>
            <Text style={styles.sectionSubtitle}>
              Subscription modification, plan upgrades, proration quotes, and financial ledger access are restricted to organization Owners (BR-006). You can view the current active subscription tier above.
            </Text>
          </View>
        )}

        {/* Quote Review Card */}
        {quote && isOwner && (
          <View style={styles.quoteCard}>
            <Text style={styles.quoteTitle}>Authoritative Server Quote</Text>
            <Text style={styles.quoteExpiry}>
              Expires in 15 min ({new Date(quote.expiresAt).toLocaleTimeString()})
            </Text>

            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Target Plan</Text>
              <Text style={styles.quoteValue}>{quote.targetPlan.toUpperCase()}</Text>
            </View>

            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Target Seats</Text>
              <Text style={styles.quoteValue}>{quote.targetSeats} seats</Text>
            </View>

            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Proration Window</Text>
              <Text style={styles.quoteValue}>
                {quote.remainingDays} / {quote.periodDays} days remaining
              </Text>
            </View>

            {quote.currency === 'NGN' && (
              <View style={styles.quoteRow}>
                <Text style={styles.quoteLabel}>Exchange Rate</Text>
                <View style={styles.quoteValueColumn}>
                  <Text style={styles.quoteValue}>
                    ₦{Number(quote.fxRate).toLocaleString()} / USD
                  </Text>
                  {quote.fxSource && (
                    <Text style={styles.quoteSubValue} numberOfLines={1}>
                      {String(quote.fxSource).replace(/_/g, ' ')}
                    </Text>
                  )}
                </View>
              </View>
            )}

            <View style={styles.quoteTotalRow}>
              <Text style={styles.quoteTotalLabel}>Prorated Due Now</Text>
              <Text style={styles.quoteTotalValue}>
                {quote.currency === 'NGN' ? '₦' : '$'}
                {(quote.amountMinor / 100).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </Text>
            </View>

            {(() => {
              const quoteAnalysis = evaluateBillingQuote(quote, subscription);
              if (quoteAnalysis.isZeroAmount) {
                return (
                  <View
                    style={[
                      styles.zeroQuoteNotice,
                      quoteAnalysis.badgeType === 'info' && styles.zeroQuoteNoticeInfo,
                    ]}
                  >
                    <Ionicons
                      name={
                        quoteAnalysis.badgeType === 'success'
                          ? 'checkmark-circle-outline'
                          : 'information-circle-outline'
                      }
                      size={18}
                      color={quoteAnalysis.badgeType === 'success' ? '#059669' : '#0284C7'}
                      style={{ marginRight: 8 }}
                    />
                    <Text
                      style={[
                        styles.zeroQuoteNoticeText,
                        quoteAnalysis.badgeType === 'info' && styles.zeroQuoteNoticeTextInfo,
                      ]}
                    >
                      {quoteAnalysis.message}
                    </Text>
                  </View>
                );
              }
              return (
                <TouchableOpacity
                  style={[styles.confirmButton, actionLoading && styles.buttonDisabled]}
                  onPress={handleConfirmAndPay}
                  disabled={actionLoading}
                  activeOpacity={0.8}
                >
                  {actionLoading ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.confirmButtonText}>Proceed to Hosted Checkout (Paystack Test Mode)</Text>
                  )}
                </TouchableOpacity>
              );
            })()}
          </View>
        )}

        {/* Owner-Only Downgrade Action */}
        {isOwner && subscription?.plan !== 'starter' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Scheduled Downgrade</Text>
            <Text style={styles.sectionSubtitle}>
              Downgrades apply at the next renewal period. No staff are silently removed.
            </Text>

            <TouchableOpacity
              style={[styles.downgradeButton, actionLoading && styles.buttonDisabled]}
              onPress={() => handleScheduleDowngrade('starter')}
              disabled={actionLoading}
              activeOpacity={0.8}
            >
              <Text style={styles.downgradeButtonText}>Schedule Downgrade to Starter (5 seats)</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Append-Only Financial Ledger (Owner Only) */}
        {isOwner && ledger.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Immutable Financial Ledger</Text>
            <Text style={styles.sectionSubtitle}>Append-only audit trail protected by database triggers.</Text>

            {ledger.map((entry: any) => (
              <View key={entry.seq} style={styles.ledgerRow}>
                <View style={styles.ledgerHeader}>
                  <Text style={styles.ledgerSeq}>#{entry.seq} {entry.type.toUpperCase()}</Text>
                  <Text style={styles.ledgerAmount}>
                    {entry.amountMinor > 0 ? `${entry.currency} ${(entry.amountMinor / 100).toFixed(2)}` : '0.00'}
                  </Text>
                </View>
                <Text style={styles.ledgerDesc}>{entry.description}</Text>
                <Text style={styles.ledgerDate}>{new Date(entry.createdAt).toLocaleString()}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Payment History (Owner Only) - Shows Succeeded, Failed, and Pending Sessions */}
        {isOwner && paymentHistory.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>Payment Attempts & History</Text>
              <View style={styles.badgeNeutral}>
                <Text style={styles.badgeNeutralText}>{paymentHistory.length} sessions</Text>
              </View>
            </View>
            <Text style={styles.sectionSubtitle}>
              Authoritative log of all checkout sessions including successful, failed, and pending attempts.
            </Text>

            {paymentHistory.map((item: any) => {
              const isSuccess = item.status === 'succeeded';
              const isFailed = item.status === 'failed';
              const isPending = item.status === 'awaiting_payment';

              const badgeStyle = isSuccess
                ? styles.historyBadgeSuccess
                : isFailed
                ? styles.historyBadgeFailed
                : isPending
                ? styles.historyBadgePending
                : styles.historyBadgeExpired;

              const badgeTextStyle = isSuccess
                ? styles.historyBadgeTextSuccess
                : isFailed
                ? styles.historyBadgeTextFailed
                : isPending
                ? styles.historyBadgeTextPending
                : styles.historyBadgeTextExpired;

              return (
                <View key={item.id} style={styles.historyRow}>
                  <View style={styles.historyTopRow}>
                    <View style={[styles.historyBadge, badgeStyle]}>
                      <Text style={[styles.historyBadgeText, badgeTextStyle]}>
                        {item.status.replace('_', ' ').toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.historyAmount}>
                      {item.currency === 'NGN' ? '₦' : '$'}
                      {(item.amountMinor / 100).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </Text>
                  </View>

                  <Text style={styles.historyRef} numberOfLines={1}>
                    Ref: {item.providerReference}
                  </Text>

                  {item.targetPlan && (
                    <Text style={styles.historyPlanDetail}>
                      Plan: {item.targetPlan.toUpperCase()} ({item.targetSeats} seats)
                    </Text>
                  )}

                  <View style={styles.historyBottomRow}>
                    <Text style={styles.historyDate}>
                      {new Date(item.createdAt).toLocaleString()}
                    </Text>
                    {isPending && (
                      <View style={styles.historyActionRow}>
                        <TouchableOpacity
                          style={styles.historyInlineBtn}
                          onPress={() => handleVerifyPayment(item.providerReference)}
                          disabled={verifyingPayment}
                        >
                          <Text style={styles.historyInlineBtnText}>Verify</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.historyInlineCancelBtn}
                          onPress={handleCancelPendingPayment}
                          disabled={actionLoading}
                        >
                          <Text style={styles.historyInlineCancelBtnText}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Paystack Checkout & Verification Modal */}
      <Modal visible={showPaymentModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderLeft}>
                <Ionicons name="card-outline" size={22} color={colors.primaryTeal} style={{ marginRight: 8 }} />
                <Text style={styles.modalTitle}>Paystack Test Checkout</Text>
              </View>
              <TouchableOpacity onPress={() => setShowPaymentModal(false)}>
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            <View style={styles.modalBody}>
              <Text style={styles.modalSubtitle}>
                A hosted checkout session has been created. Complete payment in your browser:
              </Text>

              <View style={styles.modalDetailRow}>
                <Text style={styles.modalDetailLabel}>Plan & Seats</Text>
                <Text style={styles.modalDetailValue}>
                  {quote?.targetPlan?.toUpperCase()} ({quote?.targetSeats} seats)
                </Text>
              </View>

              <View style={styles.modalDetailRow}>
                <Text style={styles.modalDetailLabel}>Total Due</Text>
                <Text style={styles.modalDetailValueHighlight}>
                  {quote?.currency} {quote?.amountMinor ? (quote.amountMinor / 100).toFixed(2) : '0.00'}
                </Text>
              </View>

              <View style={styles.modalDetailRow}>
                <Text style={styles.modalDetailLabel}>Provider Reference</Text>
                <Text style={styles.modalDetailReference} numberOfLines={1}>
                  {activePaymentIntent?.providerReference}
                </Text>
              </View>

              <View style={styles.testModeNotice}>
                <Ionicons name="shield-checkmark-outline" size={16} color={colors.primaryTeal} style={{ marginRight: 6 }} />
                <Text style={styles.testModeNoticeText}>
                  Use any Paystack test card in the browser checkout window to complete the payment.
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.verifyButton, verifyingPayment && styles.buttonDisabled]}
                onPress={handleVerifyPayment}
                disabled={verifyingPayment}
                activeOpacity={0.8}
              >
                {verifyingPayment ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name="checkmark-circle-outline" size={18} color="#FFFFFF" style={{ marginRight: 8 }} />
                    <Text style={styles.verifyButtonText}>Verify Payment Status</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.reopenButton}
                onPress={() => {
                  if (activePaymentIntent?.checkoutUrl && activePaymentIntent?.providerReference) {
                    launchPaystackCheckout(
                      activePaymentIntent.checkoutUrl,
                      activePaymentIntent.providerReference
                    );
                  }
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.reopenButtonText}>Re-open Checkout Window</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.cancelCheckoutButton}
                onPress={handleCancelPendingPayment}
                disabled={actionLoading}
                activeOpacity={0.8}
              >
                {actionLoading ? (
                  <ActivityIndicator color="#DC2626" size="small" />
                ) : (
                  <Text style={styles.cancelCheckoutButtonText}>Cancel Payment Session</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.dismissCheckoutButton}
                onPress={() => setShowPaymentModal(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.dismissCheckoutButtonText}>Keep In Progress & Close Modal</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ColorTokens, isDark: boolean) {
  return StyleSheet.create({
  keyboardContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 48,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  loadingText: {
    color: colors.textSecondary,
    marginTop: 12,
    fontSize: 14,
  },
  simulatedBanner: {
    backgroundColor: isDark ? '#78350F33' : '#FFFBEB',
    borderColor: isDark ? '#92400E' : '#FDE68A',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  simulatedBannerTitle: {
    color: isDark ? '#FCD34D' : '#92400E',
    fontWeight: '700',
    fontSize: 13,
    marginBottom: 4,
  },
  simulatedBannerSubtitle: {
    color: isDark ? '#FDE68A' : '#B45309',
    fontSize: 12,
    lineHeight: 16,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: isDark ? 0.3 : 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  sectionSubtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 4,
    marginBottom: 16,
    lineHeight: 18,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeActive: {
    backgroundColor: isDark ? '#064E3B33' : '#ECFDF5',
  },
  badgeRestricted: {
    backgroundColor: colors.errorLight,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  badgeTextActive: {
    color: isDark ? '#34D399' : '#065F46',
  },
  badgeTextRestricted: {
    color: colors.errorText,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    gap: 8,
  },
  infoLabel: {
    color: colors.textSecondary,
    fontSize: 14,
    flexShrink: 0,
  },
  infoValue: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  infoValueHighlight: {
    color: colors.primaryTeal,
    fontSize: 15,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
  },
  scheduledBanner: {
    marginTop: 12,
    padding: 12,
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: isDark ? '#0F766E' : '#99F6E4',
  },
  scheduledText: {
    color: isDark ? '#2DD4BF' : colors.tealDark,
    fontSize: 13,
    lineHeight: 18,
  },
  cancelButton: {
    marginTop: 10,
    padding: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: colors.primaryTeal,
    fontSize: 12,
    fontWeight: '600',
  },
  selectorRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  selectorButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
  },
  selectorButtonActive: {
    borderColor: colors.primaryTeal,
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
  },
  selectorText: {
    color: colors.textPrimary,
    fontWeight: '600',
    fontSize: 14,
  },
  selectorTextActive: {
    color: colors.primaryTeal,
  },
  selectorSubtext: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  inputLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  currencyRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  currencyButton: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
  },
  currencyButtonActive: {
    borderColor: colors.primaryTeal,
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
  },
  currencyText: {
    color: colors.textSecondary,
    fontWeight: '600',
  },
  currencyTextActive: {
    color: colors.primaryTeal,
  },
  counterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  counterBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  counterBtnText: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: 'bold',
  },
  counterValueContainer: {
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  counterValue: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  actionButton: {
    backgroundColor: colors.primaryTeal,
    padding: 13,
    borderRadius: 8,
    alignItems: 'center',
  },
  actionButtonText: {
    color: colors.white,
    fontWeight: '700',
    fontSize: 15,
  },
  quoteCard: {
    backgroundColor: isDark ? '#0F766E22' : colors.lightTeal,
    borderColor: isDark ? '#0F766E' : '#99F6E4',
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  quoteTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  quoteExpiry: {
    color: colors.textSecondary,
    fontSize: 12,
    marginBottom: 12,
  },
  quoteRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 6,
    gap: 12,
  },
  quoteLabel: {
    color: colors.textSecondary,
    fontSize: 14,
    flexShrink: 0,
  },
  quoteValue: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
    textAlign: 'right',
  },
  quoteValueColumn: {
    flex: 1,
    alignItems: 'flex-end',
  },
  quoteSubValue: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
    textAlign: 'right',
  },
  quoteTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: isDark ? '#0F766E' : '#99F6E4',
    marginTop: 8,
  },
  quoteTotalLabel: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  quoteTotalValue: {
    color: isDark ? '#2DD4BF' : colors.tealDark,
    fontSize: 22,
    fontWeight: '800',
  },
  confirmButton: {
    backgroundColor: colors.primaryTeal,
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 15,
  },
  downgradeButton: {
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  downgradeButtonText: {
    color: colors.textSecondary,
    fontWeight: '600',
  },
  ledgerRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  ledgerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  ledgerSeq: {
    color: colors.primaryTeal,
    fontWeight: '700',
    fontSize: 13,
  },
  ledgerAmount: {
    color: colors.success,
    fontWeight: '700',
    fontSize: 14,
  },
  ledgerDesc: {
    color: colors.textPrimary,
    fontSize: 13,
    marginTop: 2,
  },
  ledgerDate: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: isDark ? 'rgba(0, 0, 0, 0.75)' : 'rgba(15, 23, 42, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    width: '100%',
    maxWidth: 420,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: isDark ? 0.4 : 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  modalBody: {
    marginTop: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 14,
    lineHeight: 18,
  },
  modalDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  modalDetailLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  modalDetailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  modalDetailValueHighlight: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.primaryTeal,
  },
  modalDetailReference: {
    fontSize: 12,
    color: colors.textSecondary,
    maxWidth: 180,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  testModeNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    borderRadius: 8,
    padding: 10,
    marginTop: 14,
    marginBottom: 16,
  },
  zeroQuoteNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#064E3B33' : '#ECFDF5',
    borderWidth: 1,
    borderColor: isDark ? '#065F46' : '#A7F3D0',
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
  },
  zeroQuoteNoticeText: {
    flex: 1,
    fontSize: 13,
    color: isDark ? '#34D399' : '#065F46',
    lineHeight: 18,
    fontWeight: '500',
  },
  zeroQuoteNoticeInfo: {
    backgroundColor: isDark ? '#0369A133' : '#F0F9FF',
    borderColor: isDark ? '#0369A1' : '#BAE6FD',
  },
  zeroQuoteNoticeTextInfo: {
    color: isDark ? '#38BDF8' : '#0369A1',
  },
  testModeNoticeText: {
    flex: 1,
    fontSize: 12,
    color: isDark ? '#2DD4BF' : colors.tealDark,
    lineHeight: 16,
    fontWeight: '500',
  },
  verifyButton: {
    backgroundColor: colors.primaryTeal,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  verifyButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  reopenButton: {
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 8,
  },
  reopenButtonText: {
    color: colors.textPrimary,
    fontWeight: '600',
    fontSize: 13,
  },
  cancelCheckoutButton: {
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: colors.errorLight,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: 8,
    marginTop: 4,
    marginBottom: 6,
  },
  cancelCheckoutButtonText: {
    color: colors.errorText,
    fontSize: 13,
    fontWeight: '700',
  },
  dismissCheckoutButton: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  dismissCheckoutButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  pendingIntentBanner: {
    backgroundColor: isDark ? '#78350F33' : '#FEF3C7',
    borderWidth: 1,
    borderColor: isDark ? '#92400E' : '#F59E0B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  pendingIntentHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  pendingIntentTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pendingIntentTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: isDark ? '#FCD34D' : '#92400E',
  },
  pendingIntentBadge: {
    backgroundColor: isDark ? '#92400E' : '#FDE68A',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  pendingIntentBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: isDark ? '#FEF3C7' : '#78350F',
  },
  pendingIntentSubtitle: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    color: isDark ? '#FCD34D' : '#78350F',
    marginBottom: 6,
  },
  pendingIntentDescription: {
    fontSize: 13,
    lineHeight: 18,
    color: isDark ? '#FDE68A' : '#92400E',
    marginBottom: 14,
  },
  pendingIntentActions: {
    flexDirection: 'row',
    gap: 10,
  },
  pendingVerifyAction: {
    flex: 1,
    backgroundColor: colors.primaryTeal,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingVerifyActionText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  pendingCancelAction: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.error,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingCancelActionText: {
    color: colors.error,
    fontWeight: '700',
    fontSize: 13,
  },
  currentCurrencyNote: {
    fontSize: 12,
    color: colors.primaryTeal,
    fontWeight: '600',
  },
  badgeNeutral: {
    backgroundColor: isDark ? colors.surfaceSubtle : '#F1F5F9',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeNeutralText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  historyRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  historyTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  historyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  historyBadgeSuccess: {
    backgroundColor: isDark ? '#064E3B33' : '#DCFCE7',
  },
  historyBadgeFailed: {
    backgroundColor: colors.errorLight,
  },
  historyBadgePending: {
    backgroundColor: isDark ? '#78350F33' : '#FEF3C7',
  },
  historyBadgeExpired: {
    backgroundColor: isDark ? colors.surfaceSubtle : '#F1F5F9',
  },
  historyBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  historyBadgeTextSuccess: {
    color: isDark ? '#34D399' : '#15803D',
  },
  historyBadgeTextFailed: {
    color: colors.errorText,
  },
  historyBadgeTextPending: {
    color: isDark ? '#FCD34D' : '#B45309',
  },
  historyBadgeTextExpired: {
    color: colors.textSecondary,
  },
  historyAmount: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  historyRef: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2,
  },
  historyPlanDetail: {
    fontSize: 12,
    color: colors.textPrimary,
    fontWeight: '500',
    marginTop: 2,
  },
  historyBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  historyDate: {
    fontSize: 11,
    color: colors.textMuted,
  },
  historyActionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  historyInlineBtn: {
    backgroundColor: colors.primaryTeal,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  historyInlineBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  historyInlineCancelBtn: {
    backgroundColor: colors.errorLight,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  historyInlineCancelBtnText: {
    color: colors.errorText,
    fontSize: 11,
    fontWeight: '700',
  },
  restrictedContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  restrictedCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.3 : 0.05,
    shadowRadius: 8,
    elevation: 3,
    maxWidth: 380,
    width: '100%',
  },
  restrictedIconBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: isDark ? '#0F766E25' : colors.lightTeal,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  restrictedTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  restrictedMessage: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  returnButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryTeal,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    width: '100%',
  },
  returnButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  });
}
