package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
	"gymbro/internal/store"
)

// handlers holds the HTTP handlers. Route-group guards enforce authorization;
// saveWorkout also restricts source identity for user creates (see auth.go).
type handlers struct {
	store    handlerStore
	validate *validator.Validate
	// botUsername builds the sign-in deep link, without the @.
	botUsername string
	// cookieSecure sets the Secure attribute on auth cookies (false only for local HTTP).
	cookieSecure bool
}

// handlerStore is the HTTP consumer boundary; Store implements it directly.
type handlerStore interface {
	CreateLoginRequest(context.Context, time.Duration) (store.LoginRequest, error)
	ClaimLogin(context.Context, string, time.Duration) (*store.Session, error)
	ResolveIdentity(context.Context, string, string) (int64, error)
	ConfirmLogin(context.Context, string, int64) error
	DeleteSession(context.Context, string) error
	CreateWorkout(context.Context, int64, apiclient.SaveWorkoutRequest) (apiclient.SaveWorkoutResponse, error)
	SaveWorkout(context.Context, int64, apiclient.SaveWorkoutRequest) (apiclient.SaveWorkoutResponse, error)
	UpdateWorkout(context.Context, int64, int64, apiclient.UpdateWorkoutRequest) (apiclient.SaveWorkoutResponse, error)
	DeleteWorkout(context.Context, int64, int64, time.Time) error
	ListWorkouts(context.Context, int64, int, string) (apiclient.ListWorkoutsResponse, error)
	ListExercises(context.Context, int64) ([]apiclient.Exercise, error)
	ReplaceExercise(context.Context, int64, string, string) (apiclient.ReplaceExerciseResponse, error)
}

type userURI struct {
	ID int64 `uri:"id" validate:"required,gt=0"`
}

// listWorkoutsQuery: limit defaults to 20 and is bounded to 1..100 (struct tags
// cannot reference constants); before is an opaque cursor checked by the store.
type listWorkoutsQuery struct {
	Limit  int    `form:"limit,default=20" validate:"gte=1,lte=100"`
	Before string `form:"before"`
}

// register mounts the /v1 routes. service admits only the bot; userAccess
// admits the bot or a session of the :id user.
func (h *handlers) register(service, userAccess *gin.RouterGroup) {
	service.POST("/identities/resolve", h.resolveIdentity)
	writes := userAccess.Group("", requireWorkoutWrite())
	writes.POST("/users/:id/workouts", h.saveWorkout)
	writes.PUT("/users/:id/workouts/:workout_id", h.updateWorkout)
	writes.DELETE("/users/:id/workouts/:workout_id", h.deleteWorkout)
	service.GET("/users/:id/exercises", h.listExercises)
	service.POST("/users/:id/exercises/replace", h.replaceExercise)
	service.POST("/auth/telegram/confirm", h.confirmTelegram)
	userAccess.GET("/users/:id/workouts", h.listWorkouts)
}

func (h *handlers) resolveIdentity(c *gin.Context) {
	var req apiclient.ResolveIdentityRequest
	if !h.bindJSON(c, &req) || !h.valid(c, req) {
		return
	}

	userID, err := h.store.ResolveIdentity(c.Request.Context(), req.Provider, req.ExternalID)
	if err != nil {
		respondWithError(c, err)
		return
	}
	c.JSON(http.StatusOK, apiclient.ResolveIdentityResponse{UserID: userID})
}

// saveWorkout answers 201 when the workout was created and 200 when an existing one was replaced.
func (h *handlers) saveWorkout(c *gin.Context) {
	userID, ok := h.bindUser(c)
	if !ok {
		return
	}
	var req apiclient.SaveWorkoutRequest
	if !h.bindJSON(c, &req) {
		return
	}
	for i := range req.Entries {
		req.Entries[i].Name = trimName(req.Entries[i].Name)
	}
	if !h.valid(c, req) {
		return
	}

	if !currentPrincipal(c).service && (req.Source != "mobile" || h.validate.Var(req.SourceRef, "uuid") != nil) {
		respondWithError(c, apperr.ErrInvalidRequest)
		return
	}

	var resp apiclient.SaveWorkoutResponse
	var err error
	if currentPrincipal(c).service {
		resp, err = h.store.SaveWorkout(c.Request.Context(), userID, req)
	} else {
		resp, err = h.store.CreateWorkout(c.Request.Context(), userID, req)
	}
	if err != nil {
		respondWithError(c, err)
		return
	}
	status := http.StatusOK
	if resp.Created {
		status = http.StatusCreated
	}
	c.JSON(status, resp)
}

// listWorkouts serves one keyset page of workouts, newest first.
func (h *handlers) listWorkouts(c *gin.Context) {
	userID, ok := h.bindUser(c)
	if !ok {
		return
	}
	var q listWorkoutsQuery
	err := c.ShouldBindQuery(&q)
	if err != nil {
		respondWithError(c, fmt.Errorf("bind query: %v: %w", err, apperr.ErrInvalidRequest))
		return
	}
	if !h.valid(c, q) {
		return
	}

	resp, err := h.store.ListWorkouts(c.Request.Context(), userID, q.Limit, q.Before)
	if err != nil {
		respondWithError(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (h *handlers) listExercises(c *gin.Context) {
	userID, ok := h.bindUser(c)
	if !ok {
		return
	}

	exercises, err := h.store.ListExercises(c.Request.Context(), userID)
	if err != nil {
		respondWithError(c, err)
		return
	}
	c.JSON(http.StatusOK, apiclient.ListExercisesResponse{Exercises: exercises})
}

func (h *handlers) replaceExercise(c *gin.Context) {
	userID, ok := h.bindUser(c)
	if !ok {
		return
	}
	var req apiclient.ReplaceExerciseRequest
	if !h.bindJSON(c, &req) {
		return
	}
	req.BadName = trimName(req.BadName)
	req.CorrectName = trimName(req.CorrectName)
	if !h.valid(c, req) {
		return
	}

	resp, err := h.store.ReplaceExercise(c.Request.Context(), userID, req.BadName, req.CorrectName)
	if err != nil {
		respondWithError(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

// bindUser reads and validates the :id path parameter, answering 400 on failure.
func (h *handlers) bindUser(c *gin.Context) (int64, bool) {
	var uri userURI
	err := c.ShouldBindUri(&uri)
	if err != nil {
		respondWithError(c, fmt.Errorf("bind uri: %v: %w", err, apperr.ErrInvalidRequest))
		return 0, false
	}
	if !h.valid(c, uri) {
		return 0, false
	}
	return uri.ID, true
}

// bindJSON decodes the body, answering 400 on malformed JSON. Callers validate
// afterwards with valid, once any normalization is done.
func (h *handlers) bindJSON(c *gin.Context, req any) bool {
	err := c.ShouldBindJSON(req)
	if err != nil {
		respondWithError(c, fmt.Errorf("bind json: %v: %w", err, apperr.ErrInvalidRequest))
		return false
	}
	return true
}

// valid runs struct validation and answers 400 on failure.
func (h *handlers) valid(c *gin.Context, req any) bool {
	err := h.validate.Struct(req)
	if err != nil {
		respondWithError(c, fmt.Errorf("validate: %v: %w", err, apperr.ErrInvalidRequest))
		return false
	}
	return true
}

type workoutURI struct {
	ID        int64 `uri:"id" validate:"required,gt=0"`
	WorkoutID int64 `uri:"workout_id" validate:"required,gt=0"`
}

func (h *handlers) bindWorkout(c *gin.Context) (workoutURI, bool) {
	var uri workoutURI
	err := c.ShouldBindUri(&uri)
	if err != nil {
		respondWithError(c, apperr.ErrInvalidRequest)
		return uri, false
	}
	return uri, h.valid(c, uri)
}

func (h *handlers) updateWorkout(c *gin.Context) {
	uri, ok := h.bindWorkout(c)
	if !ok {
		return
	}
	var req apiclient.UpdateWorkoutRequest
	if !h.bindStrictJSON(c, &req) {
		return
	}
	for i := range req.Entries {
		req.Entries[i].Name = trimName(req.Entries[i].Name)
	}
	if !h.valid(c, req) {
		return
	}
	resp, err := h.store.UpdateWorkout(c.Request.Context(), uri.ID, uri.WorkoutID, req)
	if err != nil {
		respondWithError(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (h *handlers) deleteWorkout(c *gin.Context) {
	uri, ok := h.bindWorkout(c)
	if !ok {
		return
	}
	var req apiclient.DeleteWorkoutRequest
	if !h.bindStrictJSON(c, &req) || !h.valid(c, req) {
		return
	}
	err := h.store.DeleteWorkout(c.Request.Context(), uri.ID, uri.WorkoutID, req.ExpectedUpdatedAt)
	if err != nil {
		respondWithError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// New revision endpoints reject unknown fields, especially source identity edits.
func (h *handlers) bindStrictJSON(c *gin.Context, req any) bool {
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	err := decoder.Decode(req)
	if err == nil {
		var extra any
		err = decoder.Decode(&extra)
		if err == io.EOF {
			return true
		}
	}
	respondWithError(c, apperr.ErrInvalidRequest)
	return false
}
