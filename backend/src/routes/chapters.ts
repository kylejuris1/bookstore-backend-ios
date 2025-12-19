import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';

const router = Router();

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

export default router;

