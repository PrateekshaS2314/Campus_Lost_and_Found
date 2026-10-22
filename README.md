# Campus Lost & Found

A Phase 1 campus lost-and-found application built with Express, EJS, MongoDB, and Mongoose. Students can register a profile, report lost or found items, browse reports, and search lost-item reports. Claims and return workflows are intentionally not part of this phase.

## Technologies

- Node.js and Express.js
- EJS server-rendered templates
- MongoDB and Mongoose
- dotenv for local configuration
- HTML and CSS

## Prerequisites

- Node.js 18 or newer and npm
- A MongoDB server, either a local MongoDB installation or a MongoDB Atlas database

## Installation and configuration

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a `.env` file in the project root (or edit the supplied local-development `.env`):

   ```dotenv
   MONGODB_URI=mongodb://127.0.0.1:27017/campus_lost_found
   PORT=3000
   ```

   For Atlas, replace the local URI with your own connection string and database name. Keep credentials private; `.env` is ignored by Git. `.env.example` is a credential-free template.

3. Start MongoDB if you are using a local database.

4. Start the app:

   ```sh
   npm start
   ```

   Visit <http://localhost:3000>. The server confirms its URL after MongoDB connects. If the URI is missing or the database is unavailable, startup reports the problem and does not start a server that cannot persist data.

For development with Node's built-in file watcher, run `npm run dev`.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Homepage with live report counts and recent reports |
| GET | `/students/new` | Student registration form |
| POST | `/students` | Create a student profile |
| GET | `/students/:id` | View an individual student profile |
| GET | `/lost-items` | Browse and search lost-item reports |
| GET | `/lost-items/new` | Lost-item reporting form |
| POST | `/lost-items` | Create a lost-item report |
| GET | `/lost-items/:id` | View lost-item details |
| GET | `/found-items` | Browse found-item reports |
| GET | `/found-items/new` | Found-item reporting form |
| POST | `/found-items` | Create a found-item report |
| GET | `/found-items/:id` | View found-item details |

Lost-item search accepts `q`, for example `/lost-items?q=library`, and matches item name, category, and last-seen location.

## Models and relationships

- **Student**: required `fullName`, unique valid `email`, `department`, and `contactNumber`; MongoDB supplies the `_id`.
- **LostItem**: required `itemName`, `category`, `description`, `lastSeenLocation`, `dateLost`, and `reportedBy`; status defaults to `Open`.
- **FoundItem**: required `itemName`, `category`, `description`, `foundLocation`, `dateFound`, and `reportedBy`; status defaults to `Open`.

`LostItem.reportedBy` and `FoundItem.reportedBy` are ObjectId references to `Student`. The report forms load registered students from MongoDB for reporter selection. That selection is for attribution only and does not authenticate a student.

## Validation and error handling

Forms reject missing and whitespace-only values. Student email format and uniqueness are checked; date inputs must be valid calendar dates. Report submissions verify that the selected student ID is a valid MongoDB ObjectId and that the student exists. Invalid IDs and missing records render a 404 page. Validation and duplicate-email errors are shown on the relevant form. Unexpected request/database errors are logged on the server and shown to users only as a generic message (no database URI or stack trace is exposed).

## Phase 1 verification checklist

- [ ] Confirm MongoDB is running and `npm start` connects successfully.
- [ ] Register a student, then check that `/students/:id` shows the saved profile.
- [ ] Try registering the same email twice and confirm the duplicate is rejected.
- [ ] Submit both lost and found reports using a registered student.
- [ ] Browse the report lists, open details, and verify reporter information.
- [ ] Search lost reports by item name, category, and location.
- [ ] Check empty states before reports exist, and submit blank, invalid-date, and invalid-reference forms.
- [ ] Open malformed and nonexistent student/item IDs and confirm the 404 response.

You can run the JavaScript syntax and EJS template compilation checks with:

```sh
npm run check
```

## Demonstration

Start MongoDB, start the app, register a student, and use that profile in the lost-item and found-item report forms. Browse the report lists and detail pages to demonstrate that the content is read from MongoDB rather than hard-coded examples.
