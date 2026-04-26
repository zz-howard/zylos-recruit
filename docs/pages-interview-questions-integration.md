# Pages Integration for Reference Interview Questions

## Purpose

zylos-recruit should support generating reference interview-question documents
for candidates and roles, while avoiding a duplicate implementation of the
zylos-pages Markdown viewer.

Recruit remains useful without pages installed. When pages is available,
recruit can offer a richer document viewing experience by registering generated
Markdown files with pages.

## Design Logic

Recruit owns the recruiting workflow and the generated document content.
Reference interview-question Markdown files should be stored in the recruit
data directory as canonical source files.

Pages owns rendered document viewing. Recruit should not copy a document into
pages as the source of truth, and pages should not need to understand recruit's
candidate or role schema.

The integration is progressive enhancement:

- Recruit generates and stores a Markdown document in its own data directory.
- Recruit records document metadata needed for its own workflow.
- If pages is installed and supports external-file registration, recruit asks
  pages to register the Markdown file under a stable pages slug.
- Recruit stores the returned pages viewer URL.
- Users can open the document from recruit and view it through pages
  authentication.
- If pages is unavailable, recruit provides an authenticated raw Markdown view
  and suggests installing pages for the richer viewer.

## Source of Truth

The source of truth for generated reference interview questions is always the
Markdown file in recruit's data directory.

Recruit may store metadata such as:

- candidate
- role
- company
- title
- generator runtime/model
- created timestamp
- updated timestamp
- pages viewer URL, when registered

Pages should not store this business metadata. Pages only needs enough
registration information to manage the symlink and viewer slug.

## Permissions Model

Before a document is registered with pages, access is controlled by recruit.
This includes document generation, document listing, raw Markdown fallback, and
any edits made inside recruit.

After a document is registered with pages, viewing the rendered pages URL is
controlled by pages. This is an intentional domain transition: publishing a
document to pages makes it visible to users who can authenticate to pages.

Recruit should make that transition clear in the UI. The action should read as
opening or publishing to pages rather than implying that pages is enforcing
candidate-specific recruit permissions.

## Recruit Behavior

Recruit should add a document concept for reference interview questions without
turning into a general-purpose publishing system.

Expected behavior:

- Generate a Markdown reference interview-question document for a candidate and
  role.
- Store the Markdown under recruit's data directory.
- Keep the document associated with the candidate and role in recruit.
- Detect whether pages integration is available.
- Register the document with pages when possible.
- Show a pages viewer link when registration succeeds.
- Provide an authenticated raw Markdown fallback when pages is absent or
  registration has not happened.
- Show a clear tip that installing pages enables the richer rendered view.

Recruit should not write directly into pages internals. It should use the pages
registration surface so pages remains responsible for symlink ownership, slug
conflict handling, and source path validation.

## Acceptance Criteria

- A user can generate a reference interview-question Markdown document from a
  recruit candidate/role context.
- The generated Markdown file is stored under the recruit data directory and is
  treated as the canonical source.
- Recruit records enough metadata to list the document from the candidate or
  role context.
- When pages integration is available, recruit registers the Markdown file with
  pages and stores the returned viewer URL.
- Opening the pages URL takes the user to the pages domain and requires pages
  authentication according to pages configuration.
- Editing or regenerating the recruit-owned Markdown file is reflected in pages
  without creating a second canonical copy.
- When pages is not installed or registration is unavailable, recruit still lets
  authenticated recruit users view the raw Markdown content.
- The fallback view clearly suggests installing pages for the full rendered
  reading experience.
- Recruit does not create or mutate files inside the pages content directory
  directly.
- Removing a recruit document does not accidentally delete unrelated pages
  documents. If the document was registered with pages, recruit requests
  unregistering through the pages integration surface.
- Existing resume evaluation, candidate management, and role management flows
  continue to work unchanged.
