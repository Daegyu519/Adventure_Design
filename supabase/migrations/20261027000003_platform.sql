-- T-03b 플랫폼 설정: Realtime 구독과 Storage. 실제 Supabase에서만 실행한다.
-- PGlite 테스트에는 supabase_realtime publication·storage 스키마가 없어 helpers.freshDb가 이름에 _platform이 든 파일을 건너뛴다.

-- Realtime: 앱이 구독하는 표. RLS가 그대로 적용되어 방 멤버에게만 이벤트가 간다.
alter publication supabase_realtime add table public.messages, public.reactions, public.room_members;

-- 비공개 버킷. 파일 하나당 최대 5MB, 이미지 형식만(크기·형식 상한은 임의값: 수업 규모).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 객체 이름은 messages.image_path와 같은 모양만 허용한다: <room_id>/<파일 이름> 한 단계, '..' 금지.
-- 방 id는 요청한 객체의 첫 폴더에서 꺼낸다. uuid 변환은 이름이 모양을 통과한 뒤에만 돌도록 case로 감싼다
-- (and는 평가 순서를 보장하지 않는다). 모양이 틀린 이름은 오류 없이 거절된다.
-- 읽기·올리기는 방 멤버만. update·delete 정책이 없으므로 authenticated는 수정·삭제할 수 없다(service_role은 가능).
create policy chat_images_select on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-images'
    and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-][A-Za-z0-9._-]*$' and name !~ '\.\.'
      then public.is_member(((storage.foldername(name))[1])::uuid)
      else false end
  );

create policy chat_images_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-images'
    and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-][A-Za-z0-9._-]*$' and name !~ '\.\.'
      then public.is_member(((storage.foldername(name))[1])::uuid)
      else false end
  );
