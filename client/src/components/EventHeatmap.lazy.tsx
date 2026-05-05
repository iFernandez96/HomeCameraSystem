// iter-356-E (Slice E): default-export shim so React.lazy() can target
// the EventHeatmap component. The named-export source module
// (`EventHeatmap.tsx`) also exports helper functions
// (`buildMonthDays`, `dayBounds`, `buildDayList`) that live tests
// import directly — keeping those as named exports there avoids
// touching their callers. This shim's sole job is to give the lazy
// loader a default export to bind to.
import { EventHeatmap } from './EventHeatmap'

export default EventHeatmap
