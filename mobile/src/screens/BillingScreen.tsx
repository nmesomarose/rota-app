import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { api } from '../services/api.ts';
import { getActiveBusiness, type StoredBusiness } from '../services/storage.ts';

export function BillingScreen() {
  const [business, setBusiness] = useState<StoredBusiness | null>(null);
  const [subscription, setSubscription] = useState<any | null>(null);
  const [ledger, setLedger] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Quote State
  const [quote, setQuote] = useState<any | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<'team' | 'business'>('team');
  const [selectedCurrency, setSelectedCurrency] = useState<'USD' | 'NGN'>('USD');
  const [extraSeats, setExtraSeats] = useState<number>(0);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const biz = await getActiveBusiness();
      setBusiness(biz);

      const subRes = await api.billing.getSubscription();
      setSubscription(subRes.data);

      if (biz?.role === 'owner') {
        const ledgerRes = await api.billing.getLedger();
        setLedger(ledgerRes.data || []);
      }
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

  const handleConfirmAndPay = async () => {
    if (!quote) return;
    setActionLoading(true);
    try {
      const idempotencyKey = `mob_quote_${Date.now()}`;
      const confirmRes = await api.billing.confirmQuote(quote.id, idempotencyKey);
      const intent = confirmRes.data;

      // Complete simulated payment checkout
      await api.billing.simulateCheckout({
        providerReference: intent.providerReference,
        outcome: 'success',
      });

      Alert.alert(
        'Simulated Payment Successful',
        `Entitlement granted: Upgraded to ${quote.targetPlan.toUpperCase()} with ${quote.targetSeats} seats!`
      );
      setQuote(null);
      await loadData();
    } catch (err: any) {
      Alert.alert('Payment Error', err.message || 'Failed to complete payment');
    } finally {
      setActionLoading(false);
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
        <ActivityIndicator size="large" color="#38BDF8" />
        <Text style={styles.loadingText}>Loading subscription data...</Text>
      </View>
    );
  }

  const isOwner = business?.role === 'owner';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Simulation Banner */}
      <View style={styles.simulatedBanner}>
        <Text style={styles.simulatedBannerTitle}>⚠️ SIMULATED PAYMENT ENVIRONMENT</Text>
        <Text style={styles.simulatedBannerSubtitle}>
          Transactions use deterministic test fixtures. No real money or payment credentials are used.
        </Text>
      </View>

      {/* Subscription Card */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Subscription Details</Text>
          <View style={[styles.badge, subscription?.status === 'active' ? styles.badgeActive : styles.badgeRestricted]}>
            <Text style={styles.badgeText}>{subscription?.status?.toUpperCase()}</Text>
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
              <TouchableOpacity style={styles.cancelButton} onPress={handleCancelDowngrade}>
                <Text style={styles.cancelButtonText}>Cancel Scheduled Downgrade</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {/* Owner-Only Upgrade Section */}
      {isOwner && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Plan Upgrade & Additional Seats</Text>
          <Text style={styles.sectionSubtitle}>
            Server-calculated prorated quote with live CBN fixture exchange rates.
          </Text>

          {/* Plan Selector */}
          <View style={styles.selectorRow}>
            <TouchableOpacity
              style={[styles.selectorButton, selectedPlan === 'team' && styles.selectorButtonActive]}
              onPress={() => setSelectedPlan('team')}
            >
              <Text style={[styles.selectorText, selectedPlan === 'team' && styles.selectorTextActive]}>
                Team ($50/mo)
              </Text>
              <Text style={styles.selectorSubtext}>15 included seats</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.selectorButton, selectedPlan === 'business' && styles.selectorButtonActive]}
              onPress={() => setSelectedPlan('business')}
            >
              <Text style={[styles.selectorText, selectedPlan === 'business' && styles.selectorTextActive]}>
                Business ($120/mo)
              </Text>
              <Text style={styles.selectorSubtext}>40 included seats</Text>
            </TouchableOpacity>
          </View>

          {/* Currency Selector */}
          <Text style={styles.inputLabel}>Billing Currency</Text>
          <View style={styles.currencyRow}>
            <TouchableOpacity
              style={[styles.currencyButton, selectedCurrency === 'USD' && styles.currencyButtonActive]}
              onPress={() => setSelectedCurrency('USD')}
            >
              <Text style={[styles.currencyText, selectedCurrency === 'USD' && styles.currencyTextActive]}>
                USD ($)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.currencyButton, selectedCurrency === 'NGN' && styles.currencyButtonActive]}
              onPress={() => setSelectedCurrency('NGN')}
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
            >
              <Text style={styles.counterBtnText}>-</Text>
            </TouchableOpacity>
            <Text style={styles.counterValue}>+{extraSeats} seats</Text>
            <TouchableOpacity
              style={styles.counterBtn}
              onPress={() => setExtraSeats(extraSeats + 1)}
            >
              <Text style={styles.counterBtnText}>+</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.actionButton, actionLoading && styles.buttonDisabled]}
            onPress={handleRequestQuote}
            disabled={actionLoading}
          >
            {actionLoading ? (
              <ActivityIndicator color="#0F172A" />
            ) : (
              <Text style={styles.actionButtonText}>Generate Server Quote</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Quote Review Modal / Card */}
      {quote && (
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
              <Text style={styles.quoteValue}>
                ₦{quote.fxRate} / USD ({quote.fxSource})
              </Text>
            </View>
          )}

          <View style={styles.quoteTotalRow}>
            <Text style={styles.quoteTotalLabel}>Prorated Due Now</Text>
            <Text style={styles.quoteTotalValue}>
              {quote.currency === 'NGN' ? '₦' : '$'}
              {(quote.amountMinor / 100).toFixed(2)}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.confirmButton, actionLoading && styles.buttonDisabled]}
            onPress={handleConfirmAndPay}
            disabled={actionLoading}
          >
            {actionLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.confirmButtonText}>Confirm & Complete Simulated Payment</Text>
            )}
          </TouchableOpacity>
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
            style={styles.downgradeButton}
            onPress={() => handleScheduleDowngrade('starter')}
          >
            <Text style={styles.downgradeButtonText}>Schedule Downgrade to Starter (5 seats)</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Append-Only Financial Ledger */}
      {isOwner && ledger.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Immutable Financial Ledger</Text>
          <Text style={styles.sectionSubtitle}>Append-only audit trail protected by database triggers.</Text>

          {ledger.map((entry) => (
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B1120' },
  content: { padding: 16, paddingBottom: 40 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0B1120' },
  loadingText: { color: '#94A3B8', marginTop: 12, fontSize: 14 },
  simulatedBanner: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  simulatedBannerTitle: { color: '#FEF3C7', fontWeight: 'bold', fontSize: 13, marginBottom: 4 },
  simulatedBannerSubtitle: { color: '#FDE68A', fontSize: 12 },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  cardTitle: { color: '#F8FAFC', fontSize: 18, fontWeight: '700' },
  sectionSubtitle: { color: '#94A3B8', fontSize: 13, marginTop: 4, marginBottom: 16 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeActive: { backgroundColor: '#065F46' },
  badgeRestricted: { backgroundColor: '#991B1B' },
  badgeText: { color: '#F8FAFC', fontSize: 11, fontWeight: '700' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#334155' },
  infoLabel: { color: '#94A3B8', fontSize: 14 },
  infoValue: { color: '#F1F5F9', fontSize: 14, fontWeight: '600' },
  infoValueHighlight: { color: '#38BDF8', fontSize: 15, fontWeight: '700' },
  scheduledBanner: { marginTop: 12, padding: 10, backgroundColor: '#1E1B4B', borderRadius: 8 },
  scheduledText: { color: '#A5B4FC', fontSize: 13 },
  cancelButton: { marginTop: 8, padding: 8, backgroundColor: '#312E81', borderRadius: 6, alignItems: 'center' },
  cancelButtonText: { color: '#E0E7FF', fontSize: 12, fontWeight: '600' },
  selectorRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  selectorButton: { flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#475569', backgroundColor: '#0F172A' },
  selectorButtonActive: { borderColor: '#38BDF8', backgroundColor: '#0C4A6E' },
  selectorText: { color: '#E2E8F0', fontWeight: '600', fontSize: 14 },
  selectorTextActive: { color: '#38BDF8' },
  selectorSubtext: { color: '#94A3B8', fontSize: 11, marginTop: 2 },
  inputLabel: { color: '#CBD5E1', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  currencyRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  currencyButton: { flex: 1, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#475569', alignItems: 'center' },
  currencyButtonActive: { borderColor: '#10B981', backgroundColor: '#064E3B' },
  currencyText: { color: '#CBD5E1', fontWeight: '600' },
  currencyTextActive: { color: '#34D399' },
  counterRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  counterBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#334155', justifyContent: 'center', alignItems: 'center' },
  counterBtnText: { color: '#FFFFFF', fontSize: 20, fontWeight: 'bold' },
  counterValue: { color: '#F8FAFC', fontSize: 16, fontWeight: '600', marginHorizontal: 16 },
  actionButton: { backgroundColor: '#38BDF8', padding: 14, borderRadius: 8, alignItems: 'center' },
  actionButtonText: { color: '#0F172A', fontWeight: 'bold', fontSize: 15 },
  quoteCard: {
    backgroundColor: '#0F172A',
    borderColor: '#38BDF8',
    borderWidth: 2,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  quoteTitle: { color: '#38BDF8', fontSize: 18, fontWeight: 'bold' },
  quoteExpiry: { color: '#94A3B8', fontSize: 12, marginBottom: 12 },
  quoteRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  quoteLabel: { color: '#94A3B8', fontSize: 14 },
  quoteValue: { color: '#F1F5F9', fontSize: 14, fontWeight: '600' },
  quoteTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    marginTop: 8,
  },
  quoteTotalLabel: { color: '#F8FAFC', fontSize: 16, fontWeight: 'bold' },
  quoteTotalValue: { color: '#34D399', fontSize: 20, fontWeight: 'bold' },
  confirmButton: { backgroundColor: '#10B981', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 12 },
  confirmButtonText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  downgradeButton: { backgroundColor: '#475569', padding: 12, borderRadius: 8, alignItems: 'center' },
  downgradeButtonText: { color: '#F1F5F9', fontWeight: '600' },
  ledgerRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#334155' },
  ledgerHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  ledgerSeq: { color: '#38BDF8', fontWeight: '700', fontSize: 13 },
  ledgerAmount: { color: '#34D399', fontWeight: '700', fontSize: 14 },
  ledgerDesc: { color: '#E2E8F0', fontSize: 13, marginTop: 2 },
  ledgerDate: { color: '#64748B', fontSize: 11, marginTop: 4 },
  buttonDisabled: { opacity: 0.6 },
});
