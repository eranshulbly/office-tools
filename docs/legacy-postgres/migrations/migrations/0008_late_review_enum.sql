-- ============================================================================
-- 0008_late_review_enum.sql — new attendance status for the 10 PM rule.
-- Kept in its own migration because a new enum value must be committed before
-- it can be used at runtime by the functions in 0009.
-- ============================================================================

alter type day_status add value if not exists 'late_review';
