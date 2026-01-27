import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();

// Middleware to log all requests to payments routes
router.use((req, res, next) => {
  console.log(`[PAYMENTS_ROUTE] ${req.method} ${req.path} - ${new Date().toISOString()}`);
  console.log(`[PAYMENTS_ROUTE] Headers:`, req.headers);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`[PAYMENTS_ROUTE] Body:`, JSON.stringify(req.body, null, 2));
  }
  next();
});

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
    productId: 'credits_203',
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
    productId: 'credits_503',
  },
  {
    id: '1000',
    baseCredits: 1000,
    bonusPercent: 15,
    totalCredits: 1150,
    price: 9.99,
    productId: 'credits_1003',
  },
  {
    id: '1500',
    baseCredits: 1500,
    bonusPercent: 20,
    totalCredits: 1800,
    price: 14.99,
    productId: 'credits_1503',
  },
  {
    id: '2500',
    baseCredits: 2500,
    bonusPercent: 25,
    totalCredits: 3125,
    price: 24.99,
    productId: 'credits_2503',
  },
  {
    id: '3500',
    baseCredits: 3500,
    bonusPercent: 35,
    totalCredits: 4725,
    price: 34.99,
    productId: 'credits_3503',
  },
  {
    id: '5000',
    baseCredits: 5000,
    bonusPercent: 45,
    totalCredits: 7250,
    price: 49.99,
    productId: 'credits_5003',
  },
];

// TEMPORARY DEBUG: Log all configured product IDs on module load
console.log('[PAYMENT_ID_DEBUG] ===== CREDIT_PACKAGES INITIALIZED =====');
CREDIT_PACKAGES.forEach((pkg, index) => {
  console.log(`[PAYMENT_ID_DEBUG] Package ${index + 1}: productId="${pkg.productId}" (length: ${pkg.productId.length}, charCodes: [${pkg.productId.split('').map(c => c.charCodeAt(0)).join(', ')}])`);
});
console.log('[PAYMENT_ID_DEBUG] ========================================');

const findPackageByProductId = (productId: string) => {
  // TEMPORARY DEBUG: Log search attempt
  console.log(`[PAYMENT_ID_DEBUG] findPackageByProductId called with: "${productId}" (length: ${productId.length}, charCodes: [${productId.split('').map(c => c.charCodeAt(0)).join(', ')}])`);
  
  const result = CREDIT_PACKAGES.find((pkg) => {
    const matches = pkg.productId === productId;
    console.log(`[PAYMENT_ID_DEBUG]   Comparing "${pkg.productId}" === "${productId}": ${matches}`);
    if (!matches && pkg.productId.length === productId.length) {
      // If lengths match but strings don't, log character-by-character comparison
      console.log(`[PAYMENT_ID_DEBUG]   Lengths match but strings differ. Character comparison:`);
      for (let i = 0; i < Math.min(pkg.productId.length, productId.length); i++) {
        const pkgChar = pkg.productId[i];
        const searchChar = productId[i];
        const match = pkgChar === searchChar;
        console.log(`[PAYMENT_ID_DEBUG]     [${i}]: '${pkgChar}' (${pkgChar.charCodeAt(0)}) vs '${searchChar}' (${searchChar.charCodeAt(0)}) = ${match}`);
      }
    }
    return matches;
  });
  
  if (result) {
    console.log(`[PAYMENT_ID_DEBUG] ✅ Found package: id="${result.id}", productId="${result.productId}"`);
  } else {
    console.log(`[PAYMENT_ID_DEBUG] ❌ No package found for productId: "${productId}"`);
  }
  
  return result;
};

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
    console.log('[PAYMENT_ID_DEBUG] GET /packages - userId:', userId);
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

      console.log('[PAYMENT_ID_DEBUG] User purchased products:', Array.from(purchasedSet));
      console.log('[PAYMENT_ID_DEBUG] Filtering packages...');

      availablePackages = CREDIT_PACKAGES.filter((pkg) => {
        const isPurchased = pkg.oneTime && purchasedSet.has(pkg.productId);
        console.log(`[PAYMENT_ID_DEBUG]   Package "${pkg.productId}": oneTime=${pkg.oneTime}, purchased=${isPurchased}, included=${!isPurchased}`);
        if (isPurchased) {
          return false;
        }
        return true;
      });
    }

    console.log(`[PAYMENT_ID_DEBUG] Returning ${availablePackages.length} packages`);
    res.json(availablePackages);
  } catch (error) {
    console.error('Error returning packages:', error);
    res.status(500).json({ error: 'Failed to load packages' });
  }
});

// Verify Apple IAP receipt and credit the user
router.post('/apple/verify-receipt', async (req, res) => {
  try {
    console.log('[PAYMENT_ID_DEBUG] ===== /apple/verify-receipt REQUEST START =====');
    const { receiptData, productId, transactionId, userId } = req.body as {
      receiptData?: string;
      productId?: string;
      transactionId?: string;
      userId?: string;
    };

    // TEMPORARY DEBUG: Log incoming request data
    console.log('[PAYMENT_ID_DEBUG] Incoming request body:');
    console.log(`[PAYMENT_ID_DEBUG]   productId: "${productId}" (type: ${typeof productId}, length: ${productId?.length}, charCodes: ${productId ? `[${productId.split('').map(c => c.charCodeAt(0)).join(', ')}]` : 'null'})`);
    console.log(`[PAYMENT_ID_DEBUG]   transactionId: "${transactionId}"`);
    console.log(`[PAYMENT_ID_DEBUG]   userId: "${userId}"`);
    console.log(`[PAYMENT_ID_DEBUG]   receiptData: ${receiptData ? `present (${receiptData.length} chars)` : 'missing'}`);

    // Critical security fix: Require transactionId to prevent replay attacks
    if (!receiptData || !productId || !transactionId || !userId) {
      console.log('[PAYMENT_ID_DEBUG] ❌ Missing required fields');
      return res.status(400).json({ 
        error: 'receiptData, productId, transactionId, and userId are required' 
      });
    }

    if (!APPLE_SHARED_SECRET) {
      console.error('[PAYMENT_ID_DEBUG] ❌ APPLE_SHARED_SECRET is not configured');
      return res.status(500).json({ error: 'Apple IAP is not configured on the server.' });
    }

    // Verify receipt with Apple
    console.log('[PAYMENT_ID_DEBUG] Verifying receipt with Apple...');
    const verificationResult = await verifyAppleReceipt(receiptData);
    console.log('[PAYMENT_ID_DEBUG] Apple verification result status:', verificationResult.status);

    // Check verification status
    // 0 = valid receipt
    if (verificationResult.status !== 0) {
      console.error('[PAYMENT_ID_DEBUG] ❌ Apple receipt verification failed:', verificationResult.status);
      return res.status(400).json({
        error: 'Receipt verification failed',
        appleStatus: verificationResult.status,
      });
    }

    // Find the matching transaction in the receipt
    // Critical security fix: Always require exact transactionId match
    const inAppPurchases = verificationResult.receipt?.in_app || [];
    
    // TEMPORARY DEBUG: Log all transactions from receipt
    console.log('[PAYMENT_ID_DEBUG] Receipt contains', inAppPurchases.length, 'transactions:');
    inAppPurchases.forEach((txn: any, index: number) => {
      console.log(`[PAYMENT_ID_DEBUG]   Transaction ${index + 1}:`);
      console.log(`[PAYMENT_ID_DEBUG]     product_id: "${txn.product_id}" (length: ${txn.product_id?.length}, charCodes: ${txn.product_id ? `[${txn.product_id.split('').map((c: string) => c.charCodeAt(0)).join(', ')}]` : 'null'})`);
      console.log(`[PAYMENT_ID_DEBUG]     transaction_id: "${txn.transaction_id}"`);
      console.log(`[PAYMENT_ID_DEBUG]     Comparing receipt product_id "${txn.product_id}" === request productId "${productId}": ${txn.product_id === productId}`);
      if (txn.product_id && productId && txn.product_id.length === productId.length && txn.product_id !== productId) {
        console.log(`[PAYMENT_ID_DEBUG]     ⚠️ Lengths match but strings differ! Character-by-character:`);
        for (let i = 0; i < Math.min(txn.product_id.length, productId.length); i++) {
          const receiptChar = txn.product_id[i];
          const requestChar = productId[i];
          const match = receiptChar === requestChar;
          console.log(`[PAYMENT_ID_DEBUG]       [${i}]: '${receiptChar}' (${receiptChar.charCodeAt(0)}) vs '${requestChar}' (${requestChar.charCodeAt(0)}) = ${match}`);
        }
      }
    });
    console.log(`[PAYMENT_ID_DEBUG] Looking for transaction matching productId: "${productId}", transactionId: "${transactionId}"`);
    
    const matchingTransaction = inAppPurchases.find(
      (txn: any) => {
        const productMatch = txn.product_id === productId;
        const transactionMatch = txn.transaction_id === transactionId;
        console.log(`[PAYMENT_ID_DEBUG]   Checking transaction: product_id match=${productMatch}, transaction_id match=${transactionMatch}`);
        return productMatch && transactionMatch;
      }
    );

    if (!matchingTransaction) {
      console.error('[PAYMENT_ID_DEBUG] ❌ Transaction not found in receipt');
      console.error('[PAYMENT_ID_DEBUG]   Requested productId:', productId);
      console.error('[PAYMENT_ID_DEBUG]   Requested transactionId:', transactionId);
      return res.status(400).json({ 
        error: 'Transaction not found in receipt. Product ID and transaction ID must match exactly.',
        requestedProductId: productId,
        requestedTransactionId: transactionId,
        availableTransactions: inAppPurchases.map((txn: any) => ({
          product_id: txn.product_id,
          transaction_id: txn.transaction_id
        }))
      });
    }
    
    // Use the product_id from the receipt as the source of truth
    const receiptProductId = matchingTransaction.product_id;
    console.log('[PAYMENT_ID_DEBUG] ✅ Found matching transaction');
    console.log(`[PAYMENT_ID_DEBUG]   Receipt product_id: "${receiptProductId}" (length: ${receiptProductId?.length}, charCodes: ${receiptProductId ? `[${receiptProductId.split('').map(c => c.charCodeAt(0)).join(', ')}]` : 'null'})`);
    console.log(`[PAYMENT_ID_DEBUG]   Request productId: "${productId}" (length: ${productId?.length}, charCodes: ${productId ? `[${productId.split('').map(c => c.charCodeAt(0)).join(', ')}]` : 'null'})`);

    // Find the package by product ID
    // Use the product_id from the receipt as the source of truth (more secure)
    const finalProductId = receiptProductId || productId;
    
    console.log('[PAYMENT_ID_DEBUG] Using finalProductId:', finalProductId);
    console.log('[PAYMENT_ID_DEBUG] Available product IDs in CREDIT_PACKAGES:');
    CREDIT_PACKAGES.forEach((pkg, index) => {
      console.log(`[PAYMENT_ID_DEBUG]   [${index}] "${pkg.productId}" (length: ${pkg.productId.length})`);
    });
    
    const packageData = findPackageByProductId(finalProductId);
    if (!packageData) {
      console.error('[PAYMENT_ID_DEBUG] ❌ Product ID not found in CREDIT_PACKAGES');
      console.error(`[PAYMENT_ID_DEBUG]   finalProductId: "${finalProductId}" (from receipt: "${receiptProductId}", from request: "${productId}")`);
      console.error('[PAYMENT_ID_DEBUG]   Available IDs:', CREDIT_PACKAGES.map(p => `"${p.productId}"`).join(', '));
      return res.status(400).json({ 
        error: 'Invalid product ID',
        receivedProductId: productId,
        receiptProductId: receiptProductId,
        finalProductId: finalProductId,
        availableProductIds: CREDIT_PACKAGES.map(p => p.productId)
      });
    }
    
    console.log('[PAYMENT_ID_DEBUG] ✅ Package found:', {
      id: packageData.id,
      productId: packageData.productId,
      totalCredits: packageData.totalCredits,
      oneTime: packageData.oneTime
    });

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
    console.log('[PAYMENT_ID_DEBUG] Checking for duplicate purchase...');
    console.log(`[PAYMENT_ID_DEBUG]   packageData.oneTime: ${packageData.oneTime}`);
    console.log(`[PAYMENT_ID_DEBUG]   Checking if "${productId}" is in purchasedSet:`, purchasedSet.has(productId));
    console.log(`[PAYMENT_ID_DEBUG]   Current purchasedProducts:`, Array.from(purchasedSet));
    
    if (packageData.oneTime && purchasedSet.has(productId)) {
      console.log('[PAYMENT_ID_DEBUG] ⚠️ Product already purchased (one-time)');
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

    console.log(`[PAYMENT_ID_DEBUG] Checking if transactionId "${transactionId}" already processed...`);
    console.log(`[PAYMENT_ID_DEBUG]   Processed transactions:`, processedTransactions);
    console.log(`[PAYMENT_ID_DEBUG]   Transaction already processed: ${transactionId && processedTransactions.includes(transactionId)}`);

    if (transactionId && processedTransactions.includes(transactionId)) {
      console.log('[PAYMENT_ID_DEBUG] ⚠️ Transaction already processed');
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

    console.log('[PAYMENT_ID_DEBUG] Crediting user...');
    console.log(`[PAYMENT_ID_DEBUG]   Current credits: ${currentCredits}`);
    console.log(`[PAYMENT_ID_DEBUG]   Credits to add: ${creditsToAdd}`);
    console.log(`[PAYMENT_ID_DEBUG]   New total: ${newCredits}`);

    if (packageData.oneTime) {
      console.log(`[PAYMENT_ID_DEBUG]   Adding "${productId}" to purchasedProducts (one-time)`);
      purchasedSet.add(productId);
    }

    // Track processed transaction
    if (transactionId) {
      console.log(`[PAYMENT_ID_DEBUG]   Adding transactionId "${transactionId}" to processedTransactions`);
      processedTransactions.push(transactionId);
    }

    const updatedSettings = {
      ...userSettings,
      purchasedProducts: Array.from(purchasedSet),
      processedTransactions,
    };

    console.log('[PAYMENT_ID_DEBUG] Updating database...');
    console.log(`[PAYMENT_ID_DEBUG]   Table: ${accountTable}`);
    console.log(`[PAYMENT_ID_DEBUG]   userId: ${userId}`);
    console.log(`[PAYMENT_ID_DEBUG]   Updated purchasedProducts:`, Array.from(purchasedSet));
    console.log(`[PAYMENT_ID_DEBUG]   Updated processedTransactions:`, processedTransactions);

    const { error: updateError } = await supabaseAdmin
      .from(accountTable)
      .update({ number_of_credits: newCredits, settings: updatedSettings })
      .eq('id', userId);

    if (updateError) {
      console.error('[PAYMENT_ID_DEBUG] ❌ Failed to update credits:', updateError);
      return res.status(500).json({ error: 'Failed to update credits' });
    }

    console.log(`[PAYMENT_ID_DEBUG] ✅ Successfully credited ${creditsToAdd} credits to user ${userId} for product "${productId}"`);
    console.log('[PAYMENT_ID_DEBUG] ===== /apple/verify-receipt REQUEST END (SUCCESS) =====');

    res.json({
      success: true,
      creditsAdded: creditsToAdd,
      newTotal: newCredits,
      purchasedProducts: Array.from(purchasedSet),
    });
  } catch (error: any) {
    console.error('[PAYMENT_ID_DEBUG] ❌ Error verifying Apple receipt:', error);
    console.error('[PAYMENT_ID_DEBUG] Error stack:', error.stack);
    console.log('[PAYMENT_ID_DEBUG] ===== /apple/verify-receipt REQUEST END (ERROR) =====');
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
    console.log('[PAYMENT_ID_DEBUG] Merging guest account - purchased products:');
    console.log(`[PAYMENT_ID_DEBUG]   Guest purchased:`, guestPurchased);
    console.log(`[PAYMENT_ID_DEBUG]   User purchased:`, userPurchased);
    const mergedPurchased = Array.from(new Set([...guestPurchased, ...userPurchased]));
    console.log(`[PAYMENT_ID_DEBUG]   Merged purchased:`, mergedPurchased);

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

// IAP logging endpoint - receives logs from frontend
router.post('/logs/iap', async (req, res) => {
  console.log('[IAP_LOG_FRONTEND] ===== LOG ENDPOINT HIT =====');
  console.log('[IAP_LOG_FRONTEND] Request received at:', new Date().toISOString());
  console.log('[IAP_LOG_FRONTEND] Request body:', JSON.stringify(req.body, null, 2));
  
  try {
    const { level, message, data, timestamp, platform } = req.body;
    
    if (!level || !message) {
      console.warn('[IAP_LOG_FRONTEND] Missing required fields: level or message');
      return res.status(400).json({ error: 'level and message are required' });
    }
    
    // Log to console with appropriate level
    const logMessage = `[IAP_LOG_FRONTEND] [${level.toUpperCase()}] ${message}`;
    const logData = {
      timestamp: timestamp || new Date().toISOString(),
      platform,
      ...data
    };
    
    switch (level) {
      case 'error':
        console.error(logMessage, logData);
        break;
      case 'warn':
        console.warn(logMessage, logData);
        break;
      case 'info':
      default:
        console.log(logMessage, logData);
        break;
    }
    
    // Return success (we don't need to store these, just log them)
    res.json({ success: true, received: true });
  } catch (error: any) {
    console.error('[IAP_LOG_FRONTEND] Error processing log:', error);
    res.status(500).json({ error: 'Failed to process log' });
  }
});

// Test endpoint to verify the route is accessible
router.get('/logs/iap/test', (req, res) => {
  console.log('[IAP_LOG_FRONTEND] Test endpoint hit!');
  res.json({ 
    success: true, 
    message: 'IAP logging endpoint is accessible',
    timestamp: new Date().toISOString()
  });
});

export default router;
