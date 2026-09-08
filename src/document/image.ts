export async function readImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG, WebP, GIF, or AVIF image.')
  }
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB.')
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Couldn’t read this file. Try another image.'))
    reader.readAsDataURL(file)
  })
  const image = new Image()
  image.src = src
  try { await image.decode() } catch { throw new Error('Couldn’t open this image. Try another file.') }
  return src
}
