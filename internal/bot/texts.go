package bot

import (
	"fmt"
	stdhtml "html"

	"gymbro/internal/apiclient"
	"gymbro/internal/parser"
)

// Keys of the translation map. All user-facing text lives in texts below; the
// rest of the package only refers to keys. Values are HTML (tele.ModeHTML)
// except button labels and callback answers, which are plain text.
const (
	txtStart       = "start"
	txtHelp        = "help"
	txtWebSignedIn = "web_signed_in"

	txtReady            = "ready"
	txtNewNames         = "new_names"
	txtSuspectsHead     = "suspects_head"
	txtSuspectItem      = "suspect_item"
	txtNeedResolve      = "need_resolve"
	txtPlannedUnsavable = "planned_unsavable"
	txtSavedLine        = "saved_line"

	txtParseFailed     = "parse_failed"
	txtParseFailedLine = "parse_failed_line"

	txtBtnSave = "btn_save"
	txtBtnPick = "btn_pick"
	txtBtnKeep = "btn_keep"

	txtCbDraftMissing   = "cb_draft_missing"
	txtCbStale          = "cb_stale"
	txtCbSaved          = "cb_saved"
	txtCbStateFailed    = "cb_state_failed"
	txtCbRecoveryFailed = "cb_recovery_failed"
	txtCbCannotSave     = "cb_cannot_save"
	txtCbPlanned        = "cb_planned"
	txtCbDone           = "cb_done"

	txtNewExercisesHead = "new_exercises_head"
	txtNewExerciseItem  = "new_exercise_item"

	txtExercisesEmpty = "exercises_empty"
	txtExerciseAlias  = "exercise_alias"

	txtAliasUsage     = "alias_usage"
	txtAliasMerged    = "alias_merged"
	txtAliasAliasOnly = "alias_alias_only"
	txtAliasNotFound  = "alias_not_found"

	txtCmdExercises     = "cmd_exercises"
	txtCmdAliasExercise = "cmd_alias_exercise"
	txtCmdHelp          = "cmd_help"

	txtAPIFailure = "api_failure"
)

// Prefixes for keys built from machine codes.
const (
	prefixParseReason = "parse_reason_"
	prefixAPICode     = "api_code_"
	// apiCodeUnavailable stands in for failures that carry no API code (network, decode).
	apiCodeUnavailable = "unavailable"
	apiCodeUnknown     = "unknown"
)

var texts = map[string]string{
	txtStart: "Hi! Send a workout log and I will preview it, then press Save.\n\n" + helpBody,
	txtHelp:  helpBody,

	txtWebSignedIn: "Signed in on the web. Return to the browser.",

	txtReady:    "Ready to save.",
	txtNewNames: "New: %s",

	txtSuspectsHead:     "Possible misspellings:",
	txtSuspectItem:      "• %s: similar to %s",
	txtNeedResolve:      "Pick the correct name or keep it as new to enable Save.",
	txtPlannedUnsavable: "Unfinished sets (<code>W-</code>), cannot save yet.",
	txtSavedLine:        "<b>Saved</b> (workout #%d).",

	txtParseFailed:     "<b>Cannot parse:</b> %s",
	txtParseFailedLine: "<b>Line %d</b> <code>%s</code>: %s",

	txtBtnSave: "Save",
	txtBtnPick: "%s → %s",
	txtBtnKeep: "Keep \"%s\" as new",

	txtCbDraftMissing:   "This message is no longer tracked. Edit it or send it again.",
	txtCbStale:          "The suggestions changed, refreshed.",
	txtCbSaved:          "Saved.",
	txtCbStateFailed:    "Could not read or record the saved workout state. Try again.",
	txtCbCannotSave:     "Cannot save yet, refreshed.",
	txtCbRecoveryFailed: "Cannot identify the previously saved workout (missing, ambiguous, or outside the recovery limit). No workout was created. Check the workout history.",
	txtCbPlanned:        "Unfinished sets, cannot save yet.",
	txtCbDone:           "Done.",

	txtNewExercisesHead: "<b>New exercises created:</b>",
	txtNewExerciseItem:  "• %s: <code>/alias_exercise %s =&gt; existing exercise</code>",

	txtExercisesEmpty: "No exercises yet.",
	txtExerciseAlias:  "%s (%s)",

	txtAliasUsage:     "Usage: <code>/alias_exercise alias =&gt; existing exercise</code>",
	txtAliasMerged:    "Merged %s into %s; %s is now an alias.",
	txtAliasAliasOnly: "%s is now an alias of %s.",
	txtAliasNotFound:  "No exercise named %s. Check /exercises.",

	txtCmdExercises:     "List your exercises",
	txtCmdAliasExercise: "Make a name an alias of an exercise",
	txtCmdHelp:          "Show help",

	txtAPIFailure: "API error (%s): %s",

	prefixParseReason + string(parser.ReasonEmpty):     "The message is empty.",
	prefixParseReason + string(parser.ReasonBadDate):   "The first line must start with a date like DD.MM or DD.MM.YYYY.",
	prefixParseReason + string(parser.ReasonBadIntake): "The intake numbers in parentheses are too large.",
	prefixParseReason + string(parser.ReasonNoSets):    "The exercise line has no sets.",
	prefixParseReason + string(parser.ReasonNoName):    "The exercise line has no name.",
	prefixParseReason + string(parser.ReasonBadToken):  "This token is not a valid set (use W-R, -R or W-).",
	prefixParseReason + string(parser.ReasonZeroReps):  "A set must have at least 1 rep.",

	prefixAPICode + apiclient.CodeInvalidRequest:   "The API rejected the request.",
	prefixAPICode + apiclient.CodeUnauthorized:     "The API rejected the bot's secret.",
	prefixAPICode + apiclient.CodeWorkoutNotFound:  "The saved workout no longer exists. No workout was created.",
	prefixAPICode + apiclient.CodeUserNotFound:     "The user was not found.",
	prefixAPICode + apiclient.CodeSameExercise:     "Both names are already the same exercise.",
	prefixAPICode + apiclient.CodeExerciseNotFound: "No such exercise. Check /exercises.",
	prefixAPICode + apiclient.CodeBadNameIsAlias:   "The old name is already an alias.",
	prefixAPICode + apiclient.CodeConflict:         "Conflict with existing data.",
	prefixAPICode + apiclient.CodeInternal:         "Internal API error.",
	prefixAPICode + apiclient.CodeForbidden:        "The API refused access.",
	prefixAPICode + apiclient.CodeLoginInvalid:     "This sign-in link is invalid or already used. Start again in the browser.",
	prefixAPICode + apiclient.CodeLoginExpired:     "This sign-in link has expired. Start again in the browser.",
	prefixAPICode + apiCodeUnavailable:             "The API is unreachable.",
	prefixAPICode + apiCodeUnknown:                 "Unexpected API response.",
}

const helpBody = "Send a workout like:\n" +
	"<pre>03.10 upper (680/37)\n" +
	"жим в нахилі сміт 60-10 -9 50-11 -10\n" +
	"підтягування 82-9 -9</pre>\n" +
	"Edit the message to fix it, press Save when the preview is right.\n\n" +
	"/exercises - list your exercises\n" +
	"/alias_exercise alias =&gt; existing exercise - make a name an alias of an existing exercise\n" +
	"/help - this text"

// rawHTML marks a value that is already valid HTML, so tr does not escape it.
type rawHTML string

// tr formats texts[key] with args. string arguments are HTML-escaped; wrap
// pre-built HTML in rawHTML. Used for message text.
func tr(key string, args ...any) string {
	return fmt.Sprintf(lookup(key), escapeArgs(args)...)
}

// plain formats texts[key] without escaping: for button labels and callback
// answers, which are not parsed as HTML.
func plain(key string, args ...any) string {
	return fmt.Sprintf(lookup(key), args...)
}

func lookup(key string) string {
	text, ok := texts[key]
	if !ok {
		return key
	}
	return text
}

func escapeArgs(args []any) []any {
	out := make([]any, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case string:
			out[i] = stdhtml.EscapeString(v)
		case rawHTML:
			out[i] = string(v)
		default:
			out[i] = a
		}
	}
	return out
}

// apiErrorParts maps an API failure to its code and human message.
func apiErrorParts(err error) (code, msg string) {
	code = apiCodeUnavailable
	apiErr, ok := asAPIError(err)
	if ok {
		code = apiErr.Code
	}
	if code == "" {
		code = apiCodeUnknown
	}
	msg, known := texts[prefixAPICode+code]
	if !known {
		msg = texts[prefixAPICode+apiCodeUnknown]
	}
	return code, msg
}

// apiErrorText is the message-text (HTML) form of a failed API call: code plus message.
func apiErrorText(err error) string {
	code, msg := apiErrorParts(err)
	return tr(txtAPIFailure, code, msg)
}

// apiErrorPlain is the same for callback answers, which are plain text.
func apiErrorPlain(err error) string {
	code, msg := apiErrorParts(err)
	return plain(txtAPIFailure, code, msg)
}

// parseReasonText is the human message for a parser reason code.
func parseReasonText(r parser.Reason) string {
	msg, ok := texts[prefixParseReason+string(r)]
	if !ok {
		return string(r)
	}
	return stdhtml.EscapeString(msg)
}
