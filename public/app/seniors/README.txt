SENIORS PHOTO SCROLL — QUICK SETUP

1. Put your class photos in this folder, for example:
   01.jpg
   02.jpg
   03.png

2. Edit ../seniors/photos.json so it contains paths relative to /app/seniors.html:
   {
     "photos": [
       "./seniors/photos/01.jpg",
       "./seniors/photos/02.jpg",
       "./seniors/photos/03.png"
     ]
   }

3. Deploy the project to Cloudflare. Open:
   https://YOUR-WORKER-DOMAIN/app/seniors.html

The page uses a randomized, continuously scrolling photo wall, a restrained blue monochrome overlay, and THE END centered on screen. The original library page is unchanged.
