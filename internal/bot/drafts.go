package bot

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"gymbro/internal/bot/state"
)

// draftTTL is how long a draft survives without being touched.
const draftTTL = 48 * time.Hour

// draftSweepInterval is how often the sweeper evicts expired drafts.
const draftSweepInterval = time.Hour

// draftKey identifies a draft: the user's message in a chat.
type draftKey struct {
	ChatID int64
	MsgID  int
}

// suspectRef is one suspected misspelling as rendered; buttons refer to it by index.
type suspectRef struct {
	Key  string
	Name string
}

// draft is the working copy of the state of one user message being previewed. Its mutex
// serializes handlers working on the same draft (held across API calls); the
// cache's own mutex only protects the map.
type draft struct {
	mu sync.Mutex

	Text   string
	Posted time.Time // message date, supplies the year of a header date
	// Kept holds name keys the user chose to keep as new.
	Kept map[string]bool
	// PreviewIDs are the bot's preview message IDs, in order.
	PreviewIDs []int
	// Suspects is the ordered list of suspected names of the last render.
	Suspects []suspectRef
	// WorkoutID remains the edit target even when the preview becomes unsaved.
	WorkoutID int64
	// SavedWorkoutID marks whether the current preview matches the saved workout.
	SavedWorkoutID int64
}

// draftRecord is the persisted form of a draft (the JSON in the drafts table).
type draftRecord struct {
	Text           string
	Posted         time.Time
	Kept           []string
	PreviewIDs     []int
	Suspects       []suspectRef
	SavedWorkoutID int64
	WorkoutID      int64
}

func (d *draft) record() draftRecord {
	kept := make([]string, 0, len(d.Kept))
	for k, v := range d.Kept {
		if v {
			kept = append(kept, k)
		}
	}
	return draftRecord{Text: d.Text, Posted: d.Posted, Kept: kept, PreviewIDs: d.PreviewIDs,
		Suspects: d.Suspects, SavedWorkoutID: d.SavedWorkoutID, WorkoutID: d.WorkoutID}
}

func (r draftRecord) draft() *draft {
	kept := make(map[string]bool, len(r.Kept))
	for _, k := range r.Kept {
		kept[k] = true
	}
	return &draft{Text: r.Text, Posted: r.Posted.In(postZone), Kept: kept, PreviewIDs: r.PreviewIDs,
		Suspects: r.Suspects, SavedWorkoutID: r.SavedWorkoutID, WorkoutID: r.WorkoutID}
}

type draftEntry struct {
	d       *draft
	touched time.Time
}

// draftCache holds drafts for ttl since last touch: a map as the working copy,
// backed by the SQLite drafts table so drafts survive restarts. A draft missing
// from the map is loaded from the store before it counts as missing. Expired
// entries are evicted lazily on get and by sweep. Store errors are logged and
// never fail the caller: the in-memory draft keeps working until the next restart.
type draftCache struct {
	mu    sync.Mutex // protects items; also held across store reads so a miss loads once
	items map[draftKey]draftEntry
	store *state.Store
	ttl   time.Duration
	now   func() time.Time
}

func newDraftCache(store *state.Store, ttl time.Duration, now func() time.Time) *draftCache {
	return &draftCache{items: make(map[draftKey]draftEntry), store: store, ttl: ttl, now: now}
}

func logDraftStoreError(op string, err error) {
	log.Error().Err(err).Str("op", op).Msg("state call failed")
}

// expired reports whether a draft last touched at t is past the TTL.
func (c *draftCache) expired(t, now time.Time) bool {
	return now.Sub(t) > c.ttl
}

// adopt decodes a stored draft into the map. The caller holds c.mu.
func (c *draftCache) adopt(key draftKey, sd state.Draft) (*draft, bool) {
	var rec draftRecord
	err := json.Unmarshal([]byte(sd.Data), &rec)
	if err != nil {
		logDraftStoreError("draft_decode", err)
		return nil, false
	}
	d := rec.draft()
	c.items[key] = draftEntry{d: d, touched: sd.Touched}
	return d, true
}

// get returns the live draft for key and refreshes its TTL; on a map miss it
// loads the draft from the store.
func (c *draftCache) get(ctx context.Context, key draftKey) (*draft, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	e, ok := c.items[key]
	if !ok {
		sd, found, err := c.store.LoadDraft(ctx, key.ChatID, key.MsgID)
		if err != nil {
			logDraftStoreError("draft_load", err)
			return nil, false
		}
		if !found {
			return nil, false
		}
		if c.expired(sd.Touched, now) {
			c.deleteRow(ctx, key)
			return nil, false
		}
		d, adopted := c.adopt(key, sd)
		if !adopted {
			return nil, false
		}
		e = c.items[key]
		e.d = d
	}
	if c.expired(e.touched, now) {
		delete(c.items, key)
		c.deleteRow(ctx, key)
		return nil, false
	}
	e.touched = now
	c.items[key] = e
	return e.d, true
}

func (c *draftCache) deleteRow(ctx context.Context, key draftKey) {
	err := c.store.DeleteDraft(ctx, key.ChatID, key.MsgID)
	if err != nil {
		logDraftStoreError("draft_delete", err)
	}
}

// latest returns the key and draft touched most recently in a chat, refreshing
// nothing, looking in the map and the store. ok is false when the chat has no
// live draft.
func (c *draftCache) latest(ctx context.Context, chatID int64) (draftKey, *draft, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	var bestKey draftKey
	var best draftEntry
	found := false
	for k, e := range c.items {
		if k.ChatID != chatID || c.expired(e.touched, now) {
			continue
		}
		if !found || e.touched.After(best.touched) {
			bestKey, best, found = k, e, true
		}
	}

	msgID, sd, stored, err := c.store.LatestDraft(ctx, chatID, now.Add(-c.ttl))
	if err != nil {
		logDraftStoreError("draft_latest", err)
		return bestKey, best.d, found
	}
	storedKey := draftKey{ChatID: chatID, MsgID: msgID}
	_, inMap := c.items[storedKey]
	if !stored || inMap || (found && !sd.Touched.After(best.touched)) {
		return bestKey, best.d, found
	}
	d, adopted := c.adopt(storedKey, sd)
	if !adopted {
		return bestKey, best.d, found
	}
	return storedKey, d, true
}

// put caches a new draft and stores it. The caller holds d.mu.
func (c *draftCache) put(ctx context.Context, key draftKey, d *draft) {
	c.mu.Lock()
	now := c.now()
	c.items[key] = draftEntry{d: d, touched: now}
	c.mu.Unlock()
	c.write(ctx, key, d, now)
}

// persist writes the draft's current content through to the store. Call it
// after mutating d, while holding d.mu.
func (c *draftCache) persist(ctx context.Context, key draftKey, d *draft) {
	c.mu.Lock()
	e, ok := c.items[key]
	now := c.now()
	if ok && e.d == d {
		now = e.touched
	}
	c.mu.Unlock()
	c.write(ctx, key, d, now)
}

func (c *draftCache) write(ctx context.Context, key draftKey, d *draft, touched time.Time) {
	data, err := json.Marshal(d.record())
	if err != nil {
		logDraftStoreError("draft_encode", err)
		return
	}
	err = c.store.SaveDraft(ctx, key.ChatID, key.MsgID, state.Draft{Data: string(data), Touched: touched})
	if err != nil {
		logDraftStoreError("draft_save", err)
	}
}

// sweep evicts every expired draft from the map and the store.
func (c *draftCache) sweep(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, e := range c.items {
		if c.expired(e.touched, now) {
			delete(c.items, k)
		}
	}
	err := c.store.DeleteDraftsBefore(ctx, now.Add(-c.ttl))
	if err != nil {
		logDraftStoreError("draft_sweep", err)
	}
}

func (c *draftCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}

// runSweeper sweeps every interval until ctx is cancelled.
func (c *draftCache) runSweeper(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.sweep(ctx)
		}
	}
}
