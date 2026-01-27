import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';

const router = Router();

const CHAPTER_COST = 50; // Credits required per chapter (chapters 6+)

// Helper function to ensure account exists
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
      .select('number_of_credits, settings, paid_chapters')
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
    .select('number_of_credits, settings, paid_chapters')
    .single();

  if (created.error || !created.data) {
    console.error('Failed to fetch or create account:', created.error);
    return { error: created.error };
  }

  return { table: 'guests' as const, data: created.data };
};

// Get all chapters for a book
router.get('/book/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('chapters')
      .select('*')
      .eq('book_id', bookId)
      .order('chapter_number', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch chapters' });
  }
});

// Get a specific chapter
router.get('/book/:bookId/chapter/:chapterNumber', async (req, res) => {
  try {
    const { bookId, chapterNumber } = req.params;

    const { data, error } = await supabaseAdmin
      .from('chapters')
      .select('*')
      .eq('book_id', bookId)
      .eq('chapter_number', parseInt(chapterNumber))
      .single();

    if (error) {
      return res.status(404).json({ error: 'Chapter not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch chapter' });
  }
});

// Unlock a chapter (deducts credits and adds to paid_chapters)
router.post('/unlock', async (req, res) => {
  try {
    const { userId, bookId, chapterNumber } = req.body as {
      userId?: string;
      bookId?: string;
      chapterNumber?: number;
    };

    if (!userId || !bookId || chapterNumber === undefined) {
      return res.status(400).json({ 
        error: 'userId, bookId, and chapterNumber are required' 
      });
    }

    // Chapters 1-5 are free
    if (chapterNumber < 6) {
      return res.json({
        success: true,
        creditsDeducted: 0,
        newTotal: 0,
        message: 'Chapter is free',
      });
    }

    // Ensure account exists
    const ensured = await ensureAccount(userId);
    if ((ensured as any).error || !ensured.data) {
      return res.status(500).json({ error: 'Failed to fetch or create account' });
    }

    const accountTable = ensured.table;
    const userData = ensured.data;
    const currentCredits = userData.number_of_credits || 0;

    // Check if user has enough credits
    if (currentCredits < CHAPTER_COST) {
      return res.status(400).json({
        error: 'Insufficient credits',
        required: CHAPTER_COST,
        current: currentCredits,
      });
    }

    // Check if chapter already unlocked
    const paidChapters = Array.isArray(userData.paid_chapters) 
      ? userData.paid_chapters 
      : [];
    const chapterKey = `${bookId}:${chapterNumber}`;
    
    if (paidChapters.includes(chapterKey)) {
      return res.json({
        success: true,
        creditsDeducted: 0,
        newTotal: currentCredits,
        message: 'Chapter already unlocked',
      });
    }

    // Verify chapter exists
    const { data: chapterData, error: chapterError } = await supabaseAdmin
      .from('chapters')
      .select('chapter_number')
      .eq('book_id', bookId)
      .eq('chapter_number', chapterNumber)
      .single();

    if (chapterError || !chapterData) {
      return res.status(404).json({ error: 'Chapter not found' });
    }

    // Deduct credits and add to paid_chapters
    const newCredits = currentCredits - CHAPTER_COST;
    const updatedPaidChapters = [...paidChapters, chapterKey];

    const { error: updateError } = await supabaseAdmin
      .from(accountTable)
      .update({ 
        number_of_credits: newCredits,
        paid_chapters: updatedPaidChapters,
      })
      .eq('id', userId);

    if (updateError) {
      console.error('Failed to unlock chapter:', updateError);
      return res.status(500).json({ error: 'Failed to unlock chapter' });
    }

    console.log(`Unlocked chapter ${chapterNumber} of book ${bookId} for user ${userId}`);

    res.json({
      success: true,
      creditsDeducted: CHAPTER_COST,
      newTotal: newCredits,
      paidChapters: updatedPaidChapters,
    });
  } catch (error: any) {
    console.error('Error unlocking chapter:', error);
    res.status(500).json({ error: error.message || 'Failed to unlock chapter' });
  }
});

export default router;

