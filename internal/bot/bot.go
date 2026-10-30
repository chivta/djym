// Package bot is the Telegram front end of the workout logger: it previews
// workout messages, resolves exercise-name typos and saves through the API.
// State is the API, an in-memory draft cache and SQLite saved-message state.
package bot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog/log"
	tele "gopkg.in/telebot.v4"

	"gymbro/internal/apiclient"
	"gymbro/internal/bot/state"
	"gymbro/internal/config"
	"gymbro/internal/parser"
)

const (
	identityProvider  = "telegram"
	sourceTelegramBot = "telegram_bot"

	apiTimeout   = 10 * time.Second
	pollTimeout  = 30 * time.Second
	redactedText = "***"

	// Command names, without the slash. Telegram allows lowercase letters,
	// digits and underscores only.
	cmdStart         = "start"
	cmdHelp          = "help"
	cmdExercises     = "exercises"
	cmdAliasExercise = "alias_exercise"
)

// postZone is the zone a message's post time is read in, so a header without a
// year takes the year as the user saw it, not the UTC year.
var postZone = mustLoadLocation("Europe/Kyiv")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

// Bot wires the Telegram client, the API client and the draft cache.
type Bot struct {
	ctx       context.Context // cancelled on shutdown; bounds limiter waits and API calls
	api       *apiclient.Client
	tg        *tele.Bot
	out       *sender
	drafts    *draftCache
	state     *state.Store // saved workout IDs, first-save times and drafts; survives restarts
	allowedID int64
	userID    atomic.Int64 // internal user ID, 0 until resolved
	// redact hides the bot token in error text: telebot errors can embed the request URL.
	redact func(string) string
}

// Run starts long polling and blocks until ctx is cancelled and the poller and
// the draft sweeper have stopped.
func Run(ctx context.Context, cfg config.BotConfig) error {
	redact := func(s string) string { return strings.ReplaceAll(s, cfg.Token, redactedText) }

	tg, err := tele.NewBot(tele.Settings{
		Token: cfg.Token,
		Poller: &tele.LongPoller{
			Timeout:        pollTimeout,
			AllowedUpdates: []string{"message", "edited_message", "callback_query"},
		},
		// Errors from telebot can embed the request URL, which contains the token.
		OnError: func(err error, c tele.Context) {
			event := log.Error().Str("error", redact(err.Error()))
			if c != nil {
				event = event.Int("update_id", c.Update().ID)
			}
			event.Msg("telegram handler failed")
		},
	})
	if err != nil {
		return errors.New(redact(fmt.Sprintf("create telegram bot: %v", err)))
	}

	st, err := state.Open(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open state: %w", err)
	}
	defer st.Close()

	b := &Bot{
		state:     st,
		ctx:       ctx,
		api:       apiclient.New(cfg.APIBaseURL, cfg.APISecret, &http.Client{Timeout: apiTimeout}),
		tg:        tg,
		out:       newSender(tg),
		drafts:    newDraftCache(st, draftTTL, time.Now),
		allowedID: cfg.AllowedTelegramUserID,
		redact:    redact,
	}
	b.register()
	b.setCommands()

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		serveHealth(ctx, healthAddr)
	}()
	go func() {
		defer wg.Done()
		b.drafts.runSweeper(ctx, draftSweepInterval)
	}()
	go func() {
		defer wg.Done()
		tg.Start()
	}()

	log.Info().Int64("allowed_user_id", b.allowedID).Msg("bot started")
	<-ctx.Done()
	tg.Stop()
	wg.Wait()
	return nil
}

// register installs the access-control middleware, then the handlers. The
// middleware must be installed first: telebot applies it at Handle time.
func (b *Bot) register() {
	b.tg.Use(b.allowOnly)
	b.tg.Handle("/"+cmdStart, b.onStart)
	b.tg.Handle("/"+cmdHelp, b.onHelp)
	b.tg.Handle("/"+cmdExercises, b.onExercises)
	b.tg.Handle("/"+cmdAliasExercise, b.onAliasExercise)
	b.tg.Handle(tele.OnText, b.onText)
	b.tg.Handle(tele.OnEdited, b.onEdited)
	b.tg.Handle(tele.OnCallback, b.onCallback)
}

// setCommands publishes the command menu for the allowed user's private chat
// only (a private chat ID equals the user ID). Failure is logged, not fatal.
func (b *Bot) setCommands() {
	cmds := []tele.Command{
		{Text: cmdExercises, Description: plain(txtCmdExercises)},
		{Text: cmdAliasExercise, Description: plain(txtCmdAliasExercise)},
		{Text: cmdHelp, Description: plain(txtCmdHelp)},
	}
	err := b.tg.SetCommands(cmds, tele.CommandScope{Type: tele.CommandScopeChat, ChatID: b.allowedID})
	if err != nil {
		log.Warn().Str("error", b.redact(err.Error())).Msg("set bot commands failed")
	}
}

// allowOnly drops, silently, every update that is not from the allowed user in
// a private chat: no reply, no API call.
func (b *Bot) allowOnly(next tele.HandlerFunc) tele.HandlerFunc {
	return func(c tele.Context) error {
		sender := c.Sender()
		chat := c.Chat()
		if sender == nil || chat == nil {
			return nil
		}
		if sender.ID != b.allowedID || chat.Type != tele.ChatPrivate {
			return nil
		}
		return next(c)
	}
}

func asAPIError(err error) (*apiclient.Error, bool) {
	var apiErr *apiclient.Error
	ok := errors.As(err, &apiErr)
	return apiErr, ok
}

// apiCtx bounds one API call.
func (b *Bot) apiCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(b.ctx, apiTimeout)
}

// logAPIError logs a failed API call once, where it is turned into a user message.
func logAPIError(op string, err error) {
	event := log.Error().Err(err).Str("op", op)
	apiErr, ok := asAPIError(err)
	if ok {
		event = event.Int("status", apiErr.Status).Str("code", apiErr.Code)
	}
	event.Msg("api call failed")
}

// resolveUser returns the internal user ID of the allowed Telegram user,
// resolving it through the API on first use and caching it afterwards.
func (b *Bot) resolveUser() (int64, error) {
	cached := b.userID.Load()
	if cached != 0 {
		return cached, nil
	}
	ctx, cancel := b.apiCtx()
	defer cancel()
	resp, err := b.api.ResolveIdentity(ctx, apiclient.ResolveIdentityRequest{
		Provider:   identityProvider,
		ExternalID: strconv.FormatInt(b.allowedID, 10),
	})
	if err != nil {
		return 0, err
	}
	b.userID.Store(resp.UserID)
	return resp.UserID, nil
}

// listExercises fetches the user's exercises with their aliases.
func (b *Bot) listExercises() ([]apiclient.Exercise, error) {
	userID, err := b.resolveUser()
	if err != nil {
		return nil, err
	}
	ctx, cancel := b.apiCtx()
	defer cancel()
	resp, err := b.api.ListExercises(ctx, userID)
	if err != nil {
		return nil, err
	}
	return resp.Exercises, nil
}

// loadNames lists the user's exercises and classifies the workout's names.
func (b *Bot) loadNames(w parser.Workout) ([]nameInfo, error) {
	exercises, err := b.listExercises()
	if err != nil {
		return nil, err
	}
	return analyzeNames(w.Entries, exercises), nil
}

// buildPreview parses the draft text and renders it. It updates d.Kept (drops
// choices for names no longer present, only after a successful parse) and
// d.Suspects. The caller holds d.mu.
func (b *Bot) buildPreview(d *draft, msgID int) preview {
	w, err := parser.Parse(d.Text, d.Posted)
	if err != nil {
		d.Suspects = nil
		var perr *parser.Error
		if !errors.As(err, &perr) {
			log.Error().Err(err).Msg("parser returned an unexpected error")
			perr = &parser.Error{Reason: parser.ReasonEmpty}
		}
		return renderParseError(perr)
	}

	names, err := b.loadNames(w)
	if err != nil {
		logAPIError("list_exercises", err)
		d.Suspects = nil
		return textPreview(apiErrorText(err))
	}

	present := make(map[string]bool, len(names))
	for _, n := range names {
		present[n.Key] = true
	}
	for key := range d.Kept {
		if !present[key] {
			delete(d.Kept, key)
		}
	}

	p := renderWorkout(w, names, d.Kept, d.SavedWorkoutID, msgID)
	d.Suspects = p.Suspects
	return p
}

// refreshPreview renders the draft and makes the chat match: existing preview
// parts are edited in place, extra parts are sent, surplus parts are deleted.
// Buttons go on the last part only. userMsg is the user's message the first
// new part replies to. The caller holds d.mu.
func (b *Bot) refreshPreview(userMsg *tele.Message, d *draft) error {
	p := b.buildPreview(d, userMsg.ID)
	chatID := userMsg.Chat.ID

	for i, part := range p.Parts {
		var markup *tele.ReplyMarkup
		if i == len(p.Parts)-1 {
			markup = p.Markup
		}

		if i < len(d.PreviewIDs) {
			err := b.out.edit(b.ctx, chatID, d.PreviewIDs[i], part, markup)
			if err != nil && !isNotModified(err) {
				return err
			}
			continue
		}

		var replyTo *tele.Message
		if i == 0 {
			replyTo = userMsg
		}
		sent, err := b.out.send(b.ctx, chatID, part, markup, replyTo)
		if err != nil {
			return err
		}
		d.PreviewIDs = append(d.PreviewIDs, sent.ID)
	}

	for len(d.PreviewIDs) > len(p.Parts) {
		last := len(d.PreviewIDs) - 1
		err := b.out.remove(b.ctx, chatID, d.PreviewIDs[last])
		if err != nil {
			return err
		}
		d.PreviewIDs = d.PreviewIDs[:last]
	}
	return nil
}

func isNotModified(err error) bool {
	return errors.Is(err, tele.ErrSameMessageContent) || errors.Is(err, tele.ErrMessageNotModified)
}

// startDraft creates a draft for a user message, previews it and caches it.
func (b *Bot) startDraft(msg *tele.Message) error {
	d := &draft{Text: msg.Text, Posted: msg.Time().In(postZone), Kept: map[string]bool{}}
	d.mu.Lock()
	defer d.mu.Unlock()
	key := draftKey{ChatID: msg.Chat.ID, MsgID: msg.ID}
	b.drafts.put(b.ctx, key, d)
	defer b.drafts.persist(b.ctx, key, d) // preview IDs and suspects change in refreshPreview
	return b.refreshPreview(msg, d)
}

// sendLong sends text as one or more messages, split at line boundaries.
func (b *Bot) sendLong(chatID int64, text string) error {
	for _, part := range splitMessage(text, maxMessageRunes) {
		_, err := b.out.send(b.ctx, chatID, part, nil, nil)
		if err != nil {
			return err
		}
	}
	return nil
}

// sourceRef is the workout's source_ref: "<bot id>:<chat id>:<message id>".
// A private chat has the user's id with every bot and message ids restart at 1
// in each of them, so without the bot id a second bot would overwrite the
// workouts saved through the first.
func sourceRef(botID, chatID int64, msgID int) string {
	return strconv.FormatInt(botID, 10) + ":" + strconv.FormatInt(chatID, 10) + ":" + strconv.Itoa(msgID)
}
