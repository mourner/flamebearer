import mourner from 'eslint-config-mourner';

export default [
	...mourner,
	{
		files: ['**/*.js', 'bin/flamebearer'],
		rules: {
			'prefer-template': 'off'
		}
	}
];