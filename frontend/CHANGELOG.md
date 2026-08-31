## v2.2.1 (2025-11-06)

### Fix

- **style**: update data attribute class in authenticated layout (#249)
- prevent navigation to 500 page during development (#240)
- **style**: apply variant 'destructive' to sign-out buttons (#236)
- add missing space in profile form (#235)

### Refactor

- enhance tables and update table layout (#234)

## v2.2.0 (2025-10-09)

### Feat

- add analytics tab in dashboard page (#220)
- add extra AppTitle component for sidebar header (#216)
- update 2-column sign in page (#213)

### Fix

- update sidebar menu chevron direction in RTL mode (#229)
- pagination button spacing (#215)
- upgrade lucide-react to solve antivirus warning (#211)

### Refactor

- move sidebar related components into app-sidebar
- change SidebarInset component from 'main' to 'div'
- replace extra main container query with content container query
- replace inline svg logo with logo component (#214)

## v2.1.0 (2025-08-23)

### Feat

- enhance data table pagination with page numbers (#207)
- enhance auth flow with sign-out dialogs and redirect functionality (#206)

### Refactor

- reorganize utility files into `lib/` folder (#209)
- extract data-table components and reorganize structure (#208)

## v2.0.0 (2025-08-16)

### BREAKING CHANGE

- CSS file structure has been reorganized

### Feat

- add search param sync in apps route (#200)
- improve tables and sync table states with search param (#199)
- add data table bulk action toolbar (#196)
- add config drawer and update overall layout (#186)
- RTL support (#179)

### Fix

- adjust layout styles in search and top nav in dashboard page
- update spacing and layout styles
- update faceted icon color
- improve user table hover & selected styles (#195)
- add max-width for large screens to improve responsiveness (#194)
- adjust chat border radius for better responsiveness (#193)
- update hard-coded or inconsistent colors (#191)
- use variable for inset layout height calculation
- faded-bottom overflow issue in inset layout
- hide unnecessary configs on mobile (#189)
- adjust file input text vertical alignment (#188)

### Refactor

- enforce consistency and code quality (#198)
- improve code quality and consistency (#197)
- update error routes (#192)
- remove DirSwitch component and its usage in Tasks (#190)
- standardize using cookie as persist state (#187)
- separate CSS into modular theme and base styles (#185)
- replace tabler icons with lucide icons (#183)

## v1.4.2 (2025-07-23)

### Fix

- remove unnecessary transitions in table (#176)
- overflow background in tables (#175)

## v1.4.1 (2025-06-25)

### Fix

- user list overflow in chat (#160)
- prevent showing collapsed menu on mobile (#155)
- white background select dropdown in dark mode (#149)

### Refactor

- update font config guide in fonts.ts (#164)

## v1.4.0 (2025-05-25)

### Feat

- **clerk**: add Clerk for auth and protected route (#146)

### Fix

- add an indicator for nested pages in search (#147)
- update faded-bottom color with css variable (#139)

## v1.3.0 (2025-04-16)

### Fix

- replace custom otp with input-otp component (#131)
- disable layout animation on mobile (#130)
- upgrade react-day-picker and update calendar component (#129)

### Others

- upgrade Tailwind CSS to v4 (#125)
- upgrade dependencies (#128)
- configure automatic code-splitting (#127)

## v1.2.0 (2025-04-12)

### Feat

- add loading indicator during page transitions (#119)
- add light favicons and theme-based switching (#112)
- add new chat dialog in chats page (#90)

### Fix

- add fallback font for fontFamily (#110)
- broken focus behavior in add user dialog (#113)

## v1.1.0 (2025-01-30)

### Feat

- allow changing font family in setting

### Fix

- update sidebar color in dark mode for consistent look (#87)
- use overflow-clip in table paginations (#86)
- **style**: update global scrollbar style (#82)
- toolbar filter placeholder typo in user table (#76)

## v1.0.3 (2024-12-28)

### Fix

- add gap between buttons in import task dialog (#70)
- hide button sort if column cannot be hidden & update filterFn (#69)
- nav links added in profile dropdown (#68)

### Refactor

- optimize states in users/tasks context (#71)

## v1.0.2 (2024-12-25)

### Fix

- update overall layout due to scroll-lock bug (#66)

### Refactor

- analyze and remove unused files/exports with knip (#67)

## v1.0.1 (2024-12-14)

### Fix

- merge two button components into one (#60)
- loading all tabler-icon chunks in dev mode (#59)
- display menu dropdown when sidebar collapsed (#58)
- update spacing & alignment in dialogs/drawers
- update border & transition of sticky columns in user table
- update heading alignment to left in user dialogs
- add height and scroll area in user mutation dialogs
- update `/dashboard` route to just `/`
- **build**: replace require with import in tailwind.config.js

### Refactor

- remove unnecessary layout-backup file

## v1.0.0 (2024-12-09)

### BREAKING CHANGE

- Restructured the entire folder
hierarchy to adopt a feature-based structure. This
change improves code modularity and maintainability
but introduces breaking changes.

### Feat

- implement task dialogs
- implement user invite dialog
- implement users CRUD
- implement global command/search
- implement custom sidebar trigger
- implement coming-soon page

### Fix

- uncontrolled issue in account setting
- card layout issue in app integrations page
- remove form reset logic from useEffect in task import
- update JSX types due to react 19
- prevent card stretch in filtered app layout
- layout wrap issue in tasks page on mobile
- update user column hover and selected colors
- add setTimeout in user dialog closing
- layout shift issue in dropdown modal
- z-axis overflow issue in header
- stretch search bar only in mobile
- language dropdown issue in account setting
- update overflow contents with scroll area

### Refactor

- update layouts and extract common layout
- reorganize project to feature-based structure

## v1.0.0-beta.5 (2024-11-11)

### Feat

- add multiple language support (#37)

### Fix

- ensure site syncs with system theme changes (#49)
- recent sales responsive on ipad view (#40)

## v1.0.0-beta.4 (2024-09-22)

### Feat

- upgrade theme button to theme dropdown (#33)
- **a11y**: add "Skip to Main" button to improve keyboard navigation (#27)

### Fix

- optimize onComplete/onIncomplete invocation (#32)
- solve asChild attribute issue in custom button (#31)
- improve custom Button component (#28)

## v1.0.0-beta.3 (2024-08-25)

### Feat

- implement chat page (#21)
- add 401 error page (#12)
- implement apps page
- add otp page

### Fix

- prevent focus zoom on mobile devices (#20)
- resolve eslint script issue (#18)
- **a11y**: update default aria-label of each pin-input
- resolve OTP paste issue in multi-digit pin-input
- update layouts and solve overflow issues (#11)
- sync pin inputs programmatically

## v1.0.0-beta.2 (2024-03-18)

### Feat

- implement custom pin-input component (#2)

## v1.0.0-beta.1 (2024-02-08)

### Feat

- update theme-color meta tag when theme is updated
- add coming soon page in broken pages
- implement tasks table and page
- add remaining settings pages
- add example error page for settings
- update general error page to be more flexible
- implement settings layout and settings profile page
- add error pages
- add password-input custom component
- add sign-up page
- add forgot-password page
- add box sign in page
- add email + password sign in page
- make sidebar responsive and accessible
- add tailwind prettier plugin
- make sidebar collapsed state in local storage
- add check current active nav hook
- add loader component ui
- update dropdown nav by default if child is active
- add main-panel in dashboard
- **ui**: add dark mode
- **ui**: implement side nav ui

### Fix

- update incorrect overflow side nav height
- exclude shadcn components from linting and remove unused props
- solve text overflow issue when nav text is long
- replace nav with dropdown in mobile topnav
- make sidebar scrollable when overflow
- update nav link keys
- **ui**: update label style

### Refactor

- move password-input component into custom component dir
- add custom button component
- extract redundant codes into layout component
- update react-router to use new api for routing
- update main panel layout
- update major layouts and styling
- update main panel to be responsive
- update sidebar collapsed state to false in mobile
- update sidebar logo and title
- **ui**: remove unnecessary spacing
- remove unused files
## v0.7.2 (2026-08-31)

Please upgrade. Opening the workspace dock and switching pages could keep every visited page mounted, grow a single browser tab to about 2GB, and crash the console.

### Fix

- unmount inactive workspace dock pages so switching tabs no longer retains four large React trees and background polling
- stop request-audit live refresh while the browser tab is in the background
- shorten query cache lifetime and drop page-specific caches when a dock tab is closed
- pin old grok2api accounts via quality-guard and quality-test
- probe old grok2api accounts without model account bind
- explain official grok2api model bind window
- keep media-input thinking zero from auto-disable

### Feat

- batch-delete grok2api accounts from the isolation zone
- add admin client key quota and usage APIs and pages
- show client key usage on public quota lookup
- sync grok2api degrade-disable into the isolation zone

## v0.7.1 (2026-08-30)

### Feat

- notify grok-register after probe or isolation, like a payment callback
- document inbound webhook and notify callback contracts together

### Refactor

- rename the register result callback to notify wording
- group webhook and notify protocol buttons in register settings

## v0.7.0 (2026-08-29)

### Feat

- add task-center result preview so operators can quickly review probe HTML/text and isolate degraded accounts
- switch preview between reading and thumbnail modes, with account/task grouping and round expansion
- jump preview pages by number and remember layout across reloads
- look up grok2api client key remaining quota
- open account probe details from the task center
- copy HTML source from the formatted preview

### Fix

- keep preview thumbnails uniform, paginated, and complete across probe rounds
- open probe/run details as dialogs from preview without leaving the gallery
- close preview when the account timeline jumps to another page
- sort isolation zone by newest isolation time
- satisfy lint for result preview
- initialize preview refs for React 19 types

## v0.6.4 (2026-08-28)

### Feat

- unify workspace controls, enable/disable badges, and monitor status badges

### Fix

- restore default tooltip colors and keep quota details readable
- make the active workspace dock tab easier to see
- satisfy frontend lint for keep-alive page state

## v0.6.3 (2026-08-27)

### Fix

- satisfy release lint for isolation stats and quarantine refresh

## v0.6.2 (2026-08-27)

### Fix

- refresh isolation stats board with the isolation page

## v0.6.1 (2026-08-27)

### Feat

- align the in-app GrokIQ mark with the browser tab favicon
- reorder first-register probe profiles independently
- add isolation zone stats board and isolation timestamps
- create probe tasks from the isolation zone

### Fix

- stop showing pending action on every audit request
- drop SSE field names from missing-reasoning copy

## v0.6.0 (2026-08-27)

### Feat

- add isolation zone for degraded and high-risk accounts with auto-move rules
- add isolation notes, dock tab, and upstream account viewer
- store isolation remarks as timestamped history
- highlight remaining quota in isolation upstream viewer
- record isolation source and disable reason from audit or probes
- set grok2api priority when restoring isolated accounts
- batch disable grok2api accounts from the isolation zone
- split bootstrap settings and per-profile register probe rounds
- add exclusive probe TPS recalc modes for short windows or missing reasoning text
- show probe reasoning and upstream vs recalculated TPS

### Fix

- stop grok2api SSE after completed and skip API gzip
- keep register priority hold on insufficient samples
- keep isolation restore compatible with ES2020 and ruff
- restore generation-window TPS so grok2api flush deflation does not hide degraded accounts
- keep probe thinking text in samples
- fold account TPS back into period sample icons

## v0.5.0 (2026-08-26)

### Feat

- hold grok2api priority for newly imported register accounts until probes pass
- permanently disable confirmed register degradation when bot_risk and bfs is 1 or 2
- stream playground and probes through grok2api /v1/responses
- skip request-audit SSO recheck and keep Media Input observe from auto-disabling
- split risk and integration settings into related tabs
- compact request-audit account risk evidence

### Fix

- retry request-audit disable after failed actions or probe-restored isolation
- keep isolated accounts disabled when probe snapshots roll back

## v0.4.2 (2026-08-25)

### Feat

- add average account distribution across selected upstream egress nodes

### Fix

- keep reasoning model policy inputs focused while editing
- classify probe samples with authoritative upstream TPS
- recalculate persisted probe classifications during startup

## v0.4.1

### Fix

- use grok2api server-side request-audit timing and TPS as the authoritative probe metrics
- reconcile existing probe samples with matching request audits before recalculating account risk
