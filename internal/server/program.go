package server

import (
	"net/http"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
)

// normalizeProgram preserves display spelling and order, trimming only edges.
func normalizeProgram(name *string, entries []apiclient.ProgramEntry) bool {
	*name = trimName(*name)
	if *name == "" || utf8.RuneCountInString(*name) > apiclient.MaxNameCharacters || len(entries) == 0 || len(entries) > apiclient.MaxProgramExercises {
		return false
	}
	for i := range entries {
		e := &entries[i]
		e.Name = trimName(e.Name)
		if e.Name == "" || utf8.RuneCountInString(e.Name) > apiclient.MaxNameCharacters || e.SetCount < 1 || e.SetCount > apiclient.MaxProgramSets || (e.TargetReps != nil && (*e.TargetReps < 1 || *e.TargetReps > apiclient.MaxProgramTargetReps)) {
			return false
		}
	}
	return true
}

func (h *handlers) listPrograms(c *gin.Context) {
	userID, ok := h.bindUser(c)
	if !ok {
		return
	}
	resp, err := h.store.ListPrograms(c.Request.Context(), userID)
	if err != nil {
		respondWithError(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (h *handlers) createProgram(c *gin.Context) {
	userID, ok := h.bindUser(c)
	if !ok {
		return
	}
	var req apiclient.CreateProgramRequest
	if !h.bindStrictJSON(c, &req) || !h.valid(c, req) {
		return
	}
	if !normalizeProgram(&req.Name, req.Entries) {
		respondWithError(c, apperr.ErrInvalidRequest)
		return
	}
	resp, created, err := h.store.CreateProgram(c.Request.Context(), userID, req)
	if err != nil {
		respondWithError(c, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	c.JSON(status, resp)
}

type programURI struct {
	ID        int64  `uri:"id" validate:"required,gt=0"`
	ProgramID string `uri:"program_id" validate:"required,uuid"`
}

func (h *handlers) bindProgram(c *gin.Context) (programURI, bool) {
	var uri programURI
	if err := c.ShouldBindUri(&uri); err != nil {
		respondWithError(c, apperr.ErrInvalidRequest)
		return uri, false
	}
	return uri, h.valid(c, uri)
}

func (h *handlers) updateProgram(c *gin.Context) {
	uri, ok := h.bindProgram(c)
	if !ok {
		return
	}
	var req apiclient.UpdateProgramRequest
	if !h.bindStrictJSON(c, &req) || !h.valid(c, req) {
		return
	}
	if !normalizeProgram(&req.Name, req.Entries) {
		respondWithError(c, apperr.ErrInvalidRequest)
		return
	}
	resp, err := h.store.UpdateProgram(c.Request.Context(), uri.ID, uri.ProgramID, req)
	if err != nil {
		respondWithError(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (h *handlers) deleteProgram(c *gin.Context) {
	uri, ok := h.bindProgram(c)
	if !ok {
		return
	}
	var req apiclient.DeleteProgramRequest
	if !h.bindStrictJSON(c, &req) || !h.valid(c, req) {
		return
	}
	if err := h.store.DeleteProgram(c.Request.Context(), uri.ID, uri.ProgramID, req.ExpectedUpdatedAt); err != nil {
		respondWithError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
