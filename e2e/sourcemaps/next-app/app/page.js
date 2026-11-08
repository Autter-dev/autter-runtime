// Named main.js so its frames read like the Vite and webpack builds'
// (`onCheckoutClick@main.js`): the same defect, one issue.
import Checkout from "./main.js";

export default function Page() {
	return <Checkout />;
}
