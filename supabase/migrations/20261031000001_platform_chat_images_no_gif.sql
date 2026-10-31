-- 앱은 jpg·png·webp만 올린다(움직이는 GIF는 멈출 수 없어 뺐다, WCAG 2.2.2 — T-09c). 버킷도 같은 목록으로 맞춘다.
update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'chat-images';
