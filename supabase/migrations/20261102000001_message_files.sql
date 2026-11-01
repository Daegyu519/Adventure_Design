-- P-31 파일 첨부: messages에 파일 열 셋(경로·이름·크기). 셋은 함께 있거나 함께 없다. 사진과 파일은 한 메시지에 같이 못 담는다.
alter table public.messages add column file_path text, add column file_name text, add column file_size integer;

-- 글도 사진도 없으면 안 된다는 옛 검사(이름 messages_check)에 파일을 더한다.
alter table public.messages drop constraint messages_check;
alter table public.messages add constraint messages_has_content check (text <> '' or image_path is not null or file_path is not null);

alter table public.messages
  add constraint messages_file_all_or_none check (num_nulls(file_path, file_name, file_size) in (0, 3)),
  -- 파일은 Storage chat-files의 room_id/<파일 이름> 한 단계만(messages_image_path_room과 같은 모양)
  add constraint messages_file_path_room check (file_path is null or (
    file_path ~ ('^' || room_id::text || '/[A-Za-z0-9_-][A-Za-z0-9._-]*$') and file_path !~ '\.\.')),
  add constraint messages_file_name_ok check (file_name is null or (char_length(file_name) between 1 and 200 and file_name !~ '[[:cntrl:]]')),
  add constraint messages_file_size_ok check (file_size is null or file_size between 1 and 20971520),
  add constraint messages_one_attachment check (num_nonnulls(image_path, file_path) <= 1);

grant insert (file_path, file_name, file_size) on public.messages to authenticated;
