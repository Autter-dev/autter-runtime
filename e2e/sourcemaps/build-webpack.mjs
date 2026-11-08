// `webpack` with webpack.config.js, without webpack-cli.
import webpack from "webpack";
import config from "./webpack.config.js";

webpack(config, (err, stats) => {
	if (err || stats.hasErrors()) {
		console.error(err ?? stats.toString({ colors: false, all: false, errors: true }));
		process.exit(1);
	}
	console.log(stats.toString({ colors: false, all: false, assets: true }));
});
