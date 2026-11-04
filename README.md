# Promoter Track Sheet

A mobile website for capturing garage and reseller field visits, based on the Promoter Track Sheet Google Form. It adds GPS location, photos, and offline saving.

## What it does

- All 10 fields from the Google Form, plus the promoter's name (remembered on the phone)
- GPS latitude, longitude and accuracy, with a map link
- Up to 3 camera photos, compressed for slow networks, with date, time and GPS printed on them
- Works with no signal: visits are saved on the phone and sent automatically when back online
- A half-filled form is kept if the browser reloads (photos are not)
- "My visits" list showing what has been sent and what is still waiting
- Can be added to the phone's home screen like an app

## Where the data goes

No visit data is stored in this GitHub repository. The site sends each visit to a Google Apps Script running on your Google account:

| Data | Saved to |
| --- | --- |
| All fields, GPS, map link, photo links | Google Sheet "Promoter Track Sheet - Field Visits" |
| Photos | Private Drive folder "Promoter Track Sheet - Photos" |
| The 10 original fields | The existing Google Form (turn off with `FORWARD_TO_GOOGLE_FORM = false`) |

Share the Sheet and the Drive folder with anyone who needs to see the data. Photo links only open for people who have access to the folder.

## Connect the Google Sheet (about 5 minutes, once only)

1. Sign in to the Google account that should own the data, and open [script.google.com](https://script.google.com).
2. Click **New project**, and name it `Promoter Track Sheet`.
3. Replace the code in the editor with everything in [`backend/Code.gs`](backend/Code.gs), then click **Save**.
4. Choose `setup` in the function menu and click **Run**. Approve the permissions when asked. Google may show "Google hasn't verified this app": click **Advanced**, then **Go to Promoter Track Sheet**.
5. Click **Deploy > New deployment**, choose the type **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
6. Click **Deploy** and copy the **Web app URL**.
7. In this repository, paste the URL into `SCRIPT_URL` in [`config.js`](config.js) and commit.

The yellow "Not connected yet" banner disappears from the site within a minute or two.

If you later change `Code.gs`, use **Deploy > Manage deployments > Edit > New version** so the URL stays the same.

## Notes

- Location needs the phone's GPS on and location permission allowed for the site.
- Anyone with the link can submit a visit, the same as the Google Form.
- This site is hosted on a public repository, so its code is public, including the script URL.
