-- Nicknames are now 1-8 chars (was 20). Trim the sessions created before that.
-- Bot sessions (token_hash 'bot:...') keep their "Name (bot)" form, so the column check stays at 20.
update guest_sessions set nickname = left(nickname, 8)
where char_length(nickname) > 8 and token_hash not like 'bot:%';
