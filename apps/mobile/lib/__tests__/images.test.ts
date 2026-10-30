import { imagePath, IMAGE_TYPES } from '../images';

test('imagePath puts room id first (Storage policy reads the first folder)', () => expect(imagePath('r1', 'image/jpeg', 'abc')).toBe('r1/abc.jpg'));
test('imagePath maps every allowed type', () => expect(Object.keys(IMAGE_TYPES).map((m) => imagePath('r', m, 'x'))).toEqual(['r/x.jpg', 'r/x.png', 'r/x.webp', 'r/x.gif']));
test('imagePath rejects non-allowed types', () => expect(imagePath('r1', 'image/heic', 'abc')).toBeNull());
test('imagePath rejects unsafe random part', () => expect(imagePath('r1', 'image/png', '../x')).toBeNull());
