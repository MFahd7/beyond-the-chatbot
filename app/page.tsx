import { Docket } from './components/Docket'

/**
 * The whole interface is one client component driven by one route.
 *
 * Nothing is prerendered: the docket depends on the operator model the client
 * holds, so there is no useful static version of this page. Saying so here is
 * cheaper than discovering it as a hydration mismatch.
 */
export const dynamic = 'force-dynamic'

export default function Page() {
  return <Docket />
}
