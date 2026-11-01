-- P-31 파일 버킷. 실제 Supabase에서만 실행한다(이름에 _platform: PGlite 테스트는 건너뜀).
-- 비공개 버킷, 파일 하나당 최대 20MB. 형식 목록은 apps/mobile/lib/files.ts FILE_TYPES와 같다(그 밖의 형식은 앱이 octet-stream으로 올린다).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-files', 'chat-files', false, 20971520, array[
  'application/pdf', 'text/plain', 'text/csv', 'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/x-hwp', 'application/haansofthwp', 'application/vnd.hancom.hwp', 'application/vnd.hancom.hwpx',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif',
  'video/mp4', 'video/quicktime', 'audio/mpeg', 'audio/mp4', 'application/octet-stream'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 객체 이름은 messages.file_path와 같은 모양만 허용한다: <room_id>/<파일 이름> 한 단계, '..' 금지.
-- uuid 변환은 이름이 모양을 통과한 뒤에만 돌도록 case로 감싼다(and는 평가 순서를 보장하지 않는다).
-- 읽기·올리기는 방 멤버만. update·delete 정책이 없으므로 authenticated는 수정·삭제할 수 없다(service_role은 가능).
create policy chat_files_select on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-files'
    and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-][A-Za-z0-9._-]*$' and name !~ '\.\.'
      then public.is_member(((storage.foldername(name))[1])::uuid)
      else false end
  );

create policy chat_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-files'
    and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-][A-Za-z0-9._-]*$' and name !~ '\.\.'
      then public.is_member(((storage.foldername(name))[1])::uuid)
      else false end
  );
