import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();

// Apple App Store shared secret for receipt verification
const APPLE_SHARED_SECRET = process.env.APPLE_SHARED_SECRET || '';

// Apple receipt verification endpoints
const APPLE_PRODUCTION_VERIFY_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_VERIFY_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

type CreditPackage = {
  id: string;
  baseCredits: number;
  bonusPercent: number;
  totalCredits: number;
  price: number;
  productId: string; // Apple IAP product ID
  oneTime?: boolean;
  highlight?: boolean;
  tagline?: string;
};

// Credit packages mapped to Apple IAP product IDs
export const CREDIT_PACKAGES: CreditPackage[] = [
  {
    id: '201',
    baseCredits: 200,
    bonusPercent: 200,
    totalCredits: 600,
    price: 1.99,
    productId: 'credits_201',
    oneTime: true,
    highlight: true,
    tagline: 'Limited one-time starter boost',
  },
  {
    id: '500',
    baseCredits: 500,
    bonusPercent: 0,
    totalCredits: 500,
    price: 4.99,
    productId: 'credits_500',
  },
  {
    id: '1000',
    baseCredits: 1000,
    bonusPercent: 10,
    totalCredits: 1100,
    price: 9.99,
    productId: 'credits_1000',
  },
  {
    id: '2000',
    baseCredits: 2000,
    bonusPercent: 15,
    totalCredits: 2300,
    price: 19.99,
    productId: 'credits_2000',
  },
  {
    id: '3000',
    baseCredits: 3000,
    bonusPercent: 20,
    totalCredits: 3600,
    price: 29.99,
    productId: 'credits_3000',
  },
  {
    id: '5000',
    baseCredits: 5000,
    bonusPercent: 25,
    totalCredits: 6250,
    price: 49.99,
    productId: 'credits_5000',
  },
  {
    id: '10000',
    baseCredits: 10000,
    bonusPercent: 30,
    totalCredits: 13000,
    price: 99.99,
    productId: 'credits_10000',
  },
];

const findPackageByProductId = (productId: string) =>
  CREDIT_PACKAGES.find((pkg) => pkg.productId === productId);

const findPackageById = (id: string) => CREDIT_PACKAGES.find((pkg) => pkg.id === id);

const ensureAccount = async (userId: string) => {
  const baseProfile = {
    id: userId,
    email: null,
    number_of_credits: 0,
    bookmarks: [],
    settings: {},
    paid_chapters: [],
  };

  const fetchFrom = async (table: 'users' | 'guests') => {
    return supabaseAdmin
      .from(table)
      .select('number_of_credits, settings')
      .eq('id', userId)
      .maybeSingle();
  };

  let found = await fetchFrom('users');
  if (found.data) return { table: 'users' as const, data: found.data };

  found = await fetchFrom('guests');
  if (found.data) return { table: 'guests' as const, data: found.data };

  const created = await supabaseAdmin
    .from('guests')
    .upsert(baseProfile, { onConflict: 'id' })
    .select('number_of_credits, settings')
    .single();

  if (created.error || !created.data) {
    console.error('Failed to fetch or create account for purchase:', created.error);
    return { error: created.error };
  }

  return { table: 'guests' as const, data: created.data };
};

const parseSettings = (rawSettings: any) => {
  if (!rawSettings) return {};
  try {
    return typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings;
  } catch (err) {
    console.error('Failed to parse settings JSON:', err);
    return {};
  }
};

// Verify receipt with Apple's servers
async function verifyAppleReceipt(receiptData: string, useSandbox = false): Promise<any> {
  const verifyUrl = useSandbox ? APPLE_SANDBOX_VERIFY_URL : APPLE_PRODUCTION_VERIFY_URL;

  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'receipt-data': receiptData,
      password: APPLE_SHARED_SECRET,
      'exclude-old-transactions': true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Apple verification failed: ${response.status}`);
  }

  const result = await response.json() as { status: number; receipt?: any };

  // Status 21007 means receipt is from sandbox, retry with sandbox URL
  if (result.status === 21007 && !useSandbox) {
    return verifyAppleReceipt(receiptData, true);
  }

  return result;
}

// Get available credit packages, filtering one-time packs already owned
router.get('/packages', async (req, res) => {
  try {
    const userId = (req.query.userId as string) || null;
    let availablePackages = CREDIT_PACKAGES;

    if (userId) {
      const fetched = await ensureAccount(userId);
      if ((fetched as any).error) {
        return res.status(500).json({ error: 'Failed to load packages' });
      }

      const userSettings = parseSettings((fetched as any).data?.settings);
      const purchasedProducts = Array.isArray(userSettings?.purchasedProducts)
        ? userSettings.purchasedProducts
        : [];
      const purchasedSet = new Set(purchasedProducts);

      availablePackages = CREDIT_PACKAGES.filter((pkg) => {
        if (pkg.oneTime && purchasedSet.has(pkg.productId)) {
          return false;
        }
        return true;
      });
    }

    res.json(availablePackages);
  } catch (error) {
    console.error('Error returning packages:', error);
    res.status(500).json({ error: 'Failed to load packages' });
  }
});

// Verify Apple IAP receipt and credit the user
router.post('/apple/verify-receipt', async (req, res) => {
  try {
    const { receiptData, productId, transactionId, userId } = req.body as {
      receiptData?: string;
      productId?: string;
      transactionId?: string;
      userId?: string;
    };

    // Critical security fix: Require transactionId to prevent replay attacks
    if (!receiptData || !productId || !transactionId || !userId) {
      return res.status(400).json({ 
        error: 'receiptData, productId, transactionId, and userId are required' 
      });
    }

    if (!APPLE_SHARED_SECRET) {
      console.error('APPLE_SHARED_SECRET is not configured');
      return res.status(500).json({ error: 'Apple IAP is not configured on the server.' });
    }

    // Verify receipt with Apple
    const verificationResult = await verifyAppleReceipt(receiptData);

    // Check verification status
    // 0 = valid receipt
    if (verificationResult.status !== 0) {
      console.error('Apple receipt verification failed:', verificationResult.status);
      return res.status(400).json({
        error: 'Receipt verification failed',
        appleStatus: verificationResult.status,
      });
    }

    // Find the matching transaction in the receipt
    // Critical security fix: Always require exact transactionId match
    const inAppPurchases = verificationResult.receipt?.in_app || [];
    const matchingTransaction = inAppPurchases.find(
      (txn: any) =>
        txn.product_id === productId &&
        txn.transaction_id === transactionId
    );

    if (!matchingTransaction) {
      return res.status(400).json({ 
        error: 'Transaction not found in receipt. Product ID and transaction ID must match exactly.' 
      });
    }

    // Find the package by product ID
    const packageData = findPackageByProductId(productId);
    if (!packageData) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    // Ensure user account exists
    const ensured = await ensureAccount(userId);
    if ((ensured as any).error || !ensured.data) {
      return res.status(500).json({ error: 'Failed to fetch or create account for purchase' });
    }

    const accountTable = ensured.table;
    const userData = ensured.data;
    const userSettings = parseSettings(userData.settings);
    const purchasedProducts = Array.isArray(userSettings?.purchasedProducts)
      ? userSettings.purchasedProducts
      : [];
    const purchasedSet = new Set<string>(purchasedProducts);

    // Check for duplicate one-time purchase
    if (packageData.oneTime && purchasedSet.has(productId)) {
      return res.json({
        success: true,
        creditsAdded: 0,
        newTotal: userData.number_of_credits || 0,
        purchasedProducts: Array.from(purchasedSet),
        message: 'Product already purchased',
      });
    }

    // Store processed transaction to prevent duplicate crediting
    const processedTransactions = Array.isArray(userSettings?.processedTransactions)
      ? userSettings.processedTransactions
      : [];

    if (transactionId && processedTransactions.includes(transactionId)) {
      return res.json({
        success: true,
        creditsAdded: 0,
        newTotal: userData.number_of_credits || 0,
        purchasedProducts: Array.from(purchasedSet),
        message: 'Transaction already processed',
      });
    }

    // Credit the user
    const currentCredits = userData?.number_of_credits || 0;
    const creditsToAdd = packageData.totalCredits;
    const newCredits = currentCredits + creditsToAdd;

    if (packageData.oneTime) {
      purchasedSet.add(productId);
    }

    // Track processed transaction
    if (transactionId) {
      processedTransactions.push(transactionId);
    }

    const updatedSettings = {
      ...userSettings,
      purchasedProducts: Array.from(purchasedSet),
      processedTransactions,
    };

    const { error: updateError } = await supabaseAdmin
      .from(accountTable)
      .update({ number_of_credits: newCredits, settings: updatedSettings })
      .eq('id', userId);

    if (updateError) {
      console.error('Failed to update credits:', updateError);
      return res.status(500).json({ error: 'Failed to update credits' });
    }

    console.log(`Credited ${creditsToAdd} credits to user ${userId} for product ${productId}`);

    res.json({
      success: true,
      creditsAdded: creditsToAdd,
      newTotal: newCredits,
      purchasedProducts: Array.from(purchasedSet),
    });
  } catch (error: any) {
    console.error('Error verifying Apple receipt:', error);
    res.status(500).json({ error: error.message || 'Failed to verify receipt' });
  }
});

// Merge guest account purchases into user account (Issue #7)
router.post('/merge-guest-account', async (req, res) => {
  try {
    const { userId, guestId } = req.body as {
      userId?: string;
      guestId?: string;
    };

    if (!userId || !guestId) {
      return res.status(400).json({ error: 'userId and guestId are required' });
    }

    // Fetch guest account
    const { data: guestData, error: guestError } = await supabaseAdmin
      .from('guests')
      .select('number_of_credits, settings, paid_chapters, bookmarks')
      .eq('id', guestId)
      .maybeSingle();

    if (guestError || !guestData) {
      return res.status(404).json({ error: 'Guest account not found' });
    }

    // Fetch user account
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('number_of_credits, settings, paid_chapters, bookmarks')
      .eq('id', userId)
      .maybeSingle();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User account not found' });
    }

    // Parse settings
    const guestSettings = parseSettings(guestData.settings);
    const userSettings = parseSettings(userData.settings);

    // Merge credits
    const guestCredits = guestData.number_of_credits || 0;
    const userCredits = userData.number_of_credits || 0;
    const mergedCredits = guestCredits + userCredits;

    // Merge purchased products (union of both arrays)
    const guestPurchased = Array.isArray(guestSettings?.purchasedProducts)
      ? guestSettings.purchasedProducts
      : [];
    const userPurchased = Array.isArray(userSettings?.purchasedProducts)
      ? userSettings.purchasedProducts
      : [];
    const mergedPurchased = Array.from(new Set([...guestPurchased, ...userPurchased]));

    // Merge processed transactions
    const guestTransactions = Array.isArray(guestSettings?.processedTransactions)
      ? guestSettings.processedTransactions
      : [];
    const userTransactions = Array.isArray(userSettings?.processedTransactions)
      ? userSettings.processedTransactions
      : [];
    const mergedTransactions = Array.from(new Set([...guestTransactions, ...userTransactions]));

    // Merge paid chapters
    const guestChapters = Array.isArray(guestData.paid_chapters)
      ? guestData.paid_chapters
      : [];
    const userChapters = Array.isArray(userData.paid_chapters)
      ? userData.paid_chapters
      : [];
    const mergedChapters = Array.from(
      new Set([...guestChapters.map((c: any) => String(c)), ...userChapters.map((c: any) => String(c))])
    );

    // Merge bookmarks
    const guestBookmarks = Array.isArray(guestData.bookmarks)
      ? guestData.bookmarks
      : [];
    const userBookmarks = Array.isArray(userData.bookmarks)
      ? userData.bookmarks
      : [];
    const mergedBookmarks = Array.from(new Set([...guestBookmarks, ...userBookmarks]));

    // Update user account with merged data
    const mergedSettings = {
      ...userSettings,
      purchasedProducts: mergedPurchased,
      processedTransactions: mergedTransactions,
    };

    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        number_of_credits: mergedCredits,
        settings: mergedSettings,
        paid_chapters: mergedChapters,
        bookmarks: mergedBookmarks,
      })
      .eq('id', userId);

    if (updateError) {
      console.error('Failed to merge guest account:', updateError);
      return res.status(500).json({ error: 'Failed to merge guest account' });
    }

    // Optionally delete guest account (or keep it for audit)
    // For now, we'll keep it but you can delete if needed:
    // await supabaseAdmin.from('guests').delete().eq('id', guestId);

    console.log(`✅ Merged guest account ${guestId} into user ${userId}`);

    res.json({
      success: true,
      creditsAdded: guestCredits,
      newTotal: mergedCredits,
      purchasedProducts: mergedPurchased,
    });
  } catch (error: any) {
    console.error('Error merging guest account:', error);
    res.status(500).json({ error: error.message || 'Failed to merge guest account' });
  }
});

export default router;
