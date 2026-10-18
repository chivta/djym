// Package apiclient holds the wire types of the gymbro HTTP API and a thin client
// for it. The server imports the types, so both sides share one definition.
package apiclient

import "time"

// Error codes returned by the API as {"error": "<code>"}.
const (
	CodeInvalidRequest   = "invalid_request"
	CodeUnauthorized     = "unauthorized"
	CodeUserNotFound     = "user_not_found"
	CodeProgramNotFound  = "program_not_found"
	CodeWorkoutNotFound  = "workout_not_found"
	CodeSameExercise     = "same_exercise"
	CodeExerciseNotFound = "exercise_not_found"
	CodeBadNameIsAlias   = "bad_name_is_alias"
	CodeConflict         = "conflict"
	CodeInternal         = "internal"
	CodeForbidden        = "forbidden"
	CodeLoginInvalid     = "login_invalid"
	CodeLoginExpired     = "login_expired"
)

// Outcomes of a replace operation: merged when the bad name was an exercise,
// alias_only when it was not and only the alias was recorded.
const (
	OutcomeMerged    = "merged"
	OutcomeAliasOnly = "alias_only"
)

type ResolveIdentityRequest struct {
	Provider   string `json:"provider"    validate:"required"`
	ExternalID string `json:"external_id" validate:"required"`
}

type ResolveIdentityResponse struct {
	UserID int64 `json:"user_id"`
}

// SaveWorkoutRequest is one parsed workout. Type and Note are empty when absent.
// Type is matched case-insensitively against workout.Types and stored canonically.
// PerformedOn is an ISO date (YYYY-MM-DD). StartedAt and FinishedAt (RFC 3339)
// are both set or both absent, with FinishedAt not before StartedAt; a save
// stores them as given, so absent clears any earlier values.
type SaveWorkoutRequest struct {
	PerformedOn string     `json:"performed_on"       validate:"required,datetime=2006-01-02"`
	Name        *string    `json:"name,omitempty" validate:"omitempty,max=2000"`
	Type        string     `json:"type,omitempty"     validate:"omitempty,workout_type"`
	Kcal        *int       `json:"kcal,omitempty"     validate:"omitempty,gte=0"`
	ProteinG    *int       `json:"protein_g,omitempty" validate:"omitempty,gte=0"`
	Note        string     `json:"note,omitempty"`
	RawText     string     `json:"raw_text"           validate:"required"`
	Source      string     `json:"source"             validate:"required"`
	SourceRef   string     `json:"source_ref"         validate:"required"`
	Entries     []Entry    `json:"entries"            validate:"dive"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
}

// UpdateWorkoutRequest replaces content without changing source identity.
type UpdateWorkoutRequest struct {
	PerformedOn       string     `json:"performed_on"       validate:"required,datetime=2006-01-02"`
	Name              *string    `json:"name,omitempty" validate:"omitempty,max=2000"`
	Type              string     `json:"type,omitempty"     validate:"omitempty,workout_type"`
	Kcal              *int       `json:"kcal,omitempty"     validate:"omitempty,gte=0"`
	ProteinG          *int       `json:"protein_g,omitempty" validate:"omitempty,gte=0"`
	Note              string     `json:"note,omitempty"`
	RawText           string     `json:"raw_text"           validate:"required"`
	Entries           []Entry    `json:"entries"            validate:"dive"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	FinishedAt        *time.Time `json:"finished_at,omitempty"`
	ExpectedUpdatedAt time.Time  `json:"expected_updated_at" validate:"required"`
}

type DeleteWorkoutRequest struct {
	ExpectedUpdatedAt time.Time `json:"expected_updated_at" validate:"required"`
}

// Entry is one exercise line; its position is its index in the list. Sets may be empty.
type Entry struct {
	Name string `json:"name" validate:"required"`
	Sets []Set  `json:"sets" validate:"dive"`
}

// Set is one set; its position is its index in the list. Weight is a decimal
// string in kg with at most two fractional digits, never a float.
type Set struct {
	Weight string `json:"weight" validate:"required,weight"`
	Reps   int    `json:"reps"   validate:"gte=1"`
}

// SaveWorkoutResponse reports the upsert result. NewExercises lists the exercise
// names created by this save (deduplicated), so typos can be fixed right away.
type SaveWorkoutResponse struct {
	UpdatedAt    time.Time `json:"updated_at"`
	WorkoutID    int64     `json:"workout_id"`
	Created      bool      `json:"created"`
	NewExercises []string  `json:"new_exercises"`
}

type Exercise struct {
	ID      int64    `json:"id"`
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`
}

type ListExercisesResponse struct {
	Exercises []Exercise `json:"exercises"`
}

type ReplaceExerciseRequest struct {
	BadName     string `json:"bad_name"     validate:"required"`
	CorrectName string `json:"correct_name" validate:"required"`
}

// ReplaceExerciseResponse: Outcome is one of the Outcome* constants, Exercise the
// resulting (correct) exercise including the new alias.
type ReplaceExerciseResponse struct {
	Outcome  string   `json:"outcome"`
	Exercise Exercise `json:"exercise"`
}

// Workout is one stored workout as returned by the list endpoint. Absent optional
// fields are null. PerformedOn is an ISO date; StartedAt and FinishedAt are UTC.
// UpdatedAt is the UTC revision at database precision.
type Workout struct {
	ID          int64          `json:"id"`
	Name        string         `json:"name"`
	PerformedOn string         `json:"performed_on"`
	Type        *string        `json:"type"`
	Kcal        *int           `json:"kcal"`
	ProteinG    *int           `json:"protein_g"`
	Note        *string        `json:"note"`
	StartedAt   *time.Time     `json:"started_at"`
	FinishedAt  *time.Time     `json:"finished_at"`
	Source      string         `json:"source"`
	SourceRef   string         `json:"source_ref"`
	RawText     string         `json:"raw_text"`
	UpdatedAt   time.Time      `json:"updated_at"`
	Entries     []WorkoutEntry `json:"entries"`
}

// WorkoutEntry is one exercise line of a stored workout, ordered by position.
// Exercise is the linked exercise's display name; Sets may be empty. Weight is a
// minimal decimal string ("60", "13.5").
type WorkoutEntry struct {
	Position      int    `json:"position"`
	NameAsWritten string `json:"name_as_written"`
	Exercise      string `json:"exercise"`
	Sets          []Set  `json:"sets"`
}

// ListWorkoutsResponse is one page of workouts, newest first. NextCursor is the
// opaque value to pass as `before` for the next page, null on the last page.
type ListWorkoutsResponse struct {
	Workouts   []Workout `json:"workouts"`
	NextCursor *string   `json:"next_cursor"`
}

// Login poll statuses.
const (
	LoginPending   = "pending"
	LoginConfirmed = "confirmed"
)

// ConfirmLoginRequest is sent by the bot when a Telegram user opens a sign-in
// deep link. LoginToken is the /start payload.
type ConfirmLoginRequest struct {
	LoginToken     string `json:"login_token"      validate:"required,max=64"`
	TelegramUserID int64  `json:"telegram_user_id" validate:"required,gt=0"`
}

// StartLoginResponse: the browser opens BotURL and polls until ExpiresAt.
type StartLoginResponse struct {
	BotURL    string    `json:"bot_url"`
	ExpiresAt time.Time `json:"expires_at"`
}

// PollLoginResponse: Status is one of the Login* constants; UserID is set once confirmed.
type PollLoginResponse struct {
	Status string `json:"status"`
	UserID int64  `json:"user_id,omitempty"`
}

type MeResponse struct {
	UserID int64 `json:"user_id"`
}

// Mobile login uses an explicit client nonce and never sets a cookie.
type StartMobileLoginResponse struct {
	BotURL    string    `json:"bot_url"`
	ExpiresAt time.Time `json:"expires_at"`
	Nonce     string    `json:"nonce"`
}

type PollMobileLoginRequest struct {
	Nonce string `json:"nonce" validate:"required,len=43"`
}

type PollMobileLoginResponse struct {
	Status       string     `json:"status"`
	UserID       int64      `json:"user_id,omitempty"`
	SessionToken string     `json:"session_token,omitempty"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
}

// Shared domain limits for free names and ordered program templates.
const (
	MaxNameCharacters    = 2000
	MaxProgramExercises  = 100
	MaxProgramSets       = 100
	MaxProgramTargetReps = 9999
)

type ProgramEntry struct {
	Name       string `json:"name"`
	SetCount   int    `json:"set_count"`
	TargetReps *int   `json:"target_reps"`
}

type Program struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Entries   []ProgramEntry `json:"entries"`
	UpdatedAt time.Time      `json:"updated_at"`
}

type CreateProgramRequest struct {
	ID      string         `json:"id" validate:"required,uuid"`
	Name    string         `json:"name"`
	Entries []ProgramEntry `json:"entries"`
}

type UpdateProgramRequest struct {
	Name              string         `json:"name"`
	Entries           []ProgramEntry `json:"entries"`
	ExpectedUpdatedAt time.Time      `json:"expected_updated_at" validate:"required"`
}

type DeleteProgramRequest struct {
	ExpectedUpdatedAt time.Time `json:"expected_updated_at" validate:"required"`
}

type ListProgramsResponse struct {
	Programs []Program `json:"programs"`
}
