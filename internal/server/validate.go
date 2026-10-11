package server

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/go-playground/validator/v10"

	"gymbro/internal/apiclient"
	"gymbro/internal/workout"
)

// weightPattern: non-negative decimal with up to two fractional digits that fits numeric(6,2).
var weightPattern = regexp.MustCompile(`^\d{1,4}(\.\d{1,2})?$`)

// newValidator builds the request validator with the custom tags used by the
// apiclient request types. Call once at startup.
func newValidator() (*validator.Validate, error) {
	v := validator.New()

	err := v.RegisterValidation("weight", func(fl validator.FieldLevel) bool {
		return weightPattern.MatchString(fl.Field().String())
	})
	if err != nil {
		return nil, fmt.Errorf("register weight: %w", err)
	}

	err = v.RegisterValidation("workout_type", func(fl validator.FieldLevel) bool {
		return workout.IsType(fl.Field().String())
	})
	if err != nil {
		return nil, fmt.Errorf("register workout_type: %w", err)
	}

	v.RegisterStructValidation(validateTimes, apiclient.SaveWorkoutRequest{}, apiclient.UpdateWorkoutRequest{})
	return v, nil
}

// validateTimes: started_at and finished_at come together, finished not before started.
func validateTimes(sl validator.StructLevel) {
	var req apiclient.SaveWorkoutRequest
	switch r := sl.Current().Interface().(type) {
	case apiclient.SaveWorkoutRequest:
		req = r
	case apiclient.UpdateWorkoutRequest:
		req.StartedAt, req.FinishedAt = r.StartedAt, r.FinishedAt
	}
	if (req.StartedAt == nil) != (req.FinishedAt == nil) {
		sl.ReportError(req.FinishedAt, "FinishedAt", "finished_at", "times_together", "")
		return
	}
	if req.StartedAt != nil && req.FinishedAt.Before(*req.StartedAt) {
		sl.ReportError(req.FinishedAt, "FinishedAt", "finished_at", "gte_started_at", "")
	}
}

// trimName strips surrounding whitespace so a blank name fails `required`.
func trimName(name string) string {
	return strings.TrimSpace(name)
}
